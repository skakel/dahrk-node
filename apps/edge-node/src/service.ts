/**
 * `dahrk service install` / `uninstall` - turn this client into an always-on node without pm2. It
 * generates and registers the native supervisor for the host: a launchd LaunchAgent on macOS
 * (`~/Library/LaunchAgents/ai.dahrk.node.plist`) or a systemd *user* service on Linux
 * (`~/.config/systemd/user/dahrk-node.service`). Either one runs `dahrk start` on boot, restarts it on
 * failure, and streams logs - so a clean Mac or a clean Linux VPS yields a node that survives reboot and
 * re-attaches (its stable id is already persisted at `~/.dahrk/node.json`, so no hand-set DAHRK_NODE_ID).
 *
 * Two deliberate choices:
 *  - We register a *user* service, not a system one, so `install` needs no root. On Linux that means the
 *    service is tied to the user's login session, so we also enable *linger* (`loginctl enable-linger`)
 *    so it starts at boot and keeps running after logout - the thing a headless VPS needs.
 *  - The enrolment token is written into the service's *environment block*, not its argv, so it never
 *    shows up in `ps`. `dahrk start` reads `DAHRK_ENROL_TOKEN`; the unit passes it (plus any hub-url /
 *    name override) that way. The service invokes `node <this client's main.js> start` by absolute path,
 *    because launchd/systemd run with a minimal PATH where a bare `dahrk` may not resolve. For the same
 *    reason we snapshot the operator's PATH at install time into the env block, so once running the node
 *    resolves `git` and the runtime CLIs (claude / codex / pi) the same way their interactive shell does
 *    - otherwise the daemon would connect but detect no runtimes and serve no Jobs.
 *
 * The plan builders (which manager, which file, what content, which loader commands) are pure so they
 * unit-test without a host or a real supervisor; `runServiceInstall` / `runServiceUninstall` are the thin
 * IO shells that write the file, run the loader, and print the result.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform, userInfo } from "node:os";
import { join } from "node:path";
import { logDir as resolveLogDir } from "./state.js";

/** The unit file carries the enrolment token in its environment block, so it is owner-only. */
export const UNIT_FILE_MODE = 0o600;

/** The native supervisor we target for a given OS. `unsupported` covers Windows and anything else - we
 *  print how to run under pm2 instead rather than pretend. */
export type Manager = "launchd" | "systemd" | "unsupported";

/** launchd label / systemd unit name. The plist filename is `${LABEL}.plist`; the unit is `${UNIT}`. */
export const LAUNCHD_LABEL = "ai.dahrk.node";
export const SYSTEMD_UNIT = "dahrk-node.service";

/** Map a Node platform string to the supervisor we drive. */
export function detectManager(plat: NodeJS.Platform): Manager {
  if (plat === "darwin") return "launchd";
  if (plat === "linux") return "systemd";
  return "unsupported";
}

/** One command the IO shell runs after (un)writing the unit. `ignoreFailure` marks a best-effort step
 *  whose non-zero exit is not fatal (e.g. unloading a service that was never loaded). */
export interface ServiceCommand {
  argv: string[];
  ignoreFailure?: boolean;
}

/** The fully-resolved inputs a plan needs: the absolute node + script to run, the token and optional
 *  overrides to pass via the environment, and the home / log directories to anchor paths in. */
export interface PlanInputs {
  manager: "launchd" | "systemd";
  /** The Node binary to exec (`process.execPath`). */
  nodeBin: string;
  /** This client's entry script, resolved through any symlink (`realpath(process.argv[1])`). */
  scriptPath: string;
  /** Enrolment token, written into the service environment (not argv). */
  token: string;
  /** Optional display-name override (DAHRK_NODE_NAME). */
  name?: string;
  /** Optional hub URL override (DAHRK_HUB_URL); unset lets the client default to wss://api.dahrk.ai. */
  hubUrl?: string;
  /** PATH to export into the service, so the daemonised node finds `git` and the runtime CLIs
   *  (claude / codex / pi) the same way the operator's interactive shell does. launchd / systemd run
   *  with a minimal PATH that excludes Homebrew / npm-global bins, so without this the node would come
   *  up, connect, and then detect no runtimes - always-on but serving no Jobs. Unset omits it. */
  pathEnv?: string;
  homeDir: string;
  /** Directory launchd writes stdout/stderr logs to (systemd uses the journal). */
  logDir: string;
}

/** A rendered service registration: where the file goes, what it contains, the commands to load / stop /
 *  unload it, and a one-line hint for where its logs land. */
export interface ServicePlan {
  manager: "launchd" | "systemd";
  label: string;
  filePath: string;
  content: string;
  installCommands: ServiceCommand[];
  /** Stop the node NOW and keep it stopped across a reboot, without deregistering it - `dahrk stop`.
   *  Both managers need more than their bare "stop" verb to make it stick: a launchd agent is re-loaded at
   *  the next login unless unloaded with `-w`, and a systemd unit that is merely `stop`ped comes back at
   *  the next boot because it is still enabled. Otherwise `dahrk stop` would silently un-stop itself. */
  stopCommands: ServiceCommand[];
  uninstallCommands: ServiceCommand[];
  logHint: string;
}

/** The argv the supervisor runs. `--foreground` is the load-bearing part: `dahrk start` on its own now
 *  means "ensure the node is running as a service", which is precisely what the supervisor is already
 *  doing - so a unit that invoked bare `start` would have the daemon see itself running, exit 0, and get
 *  restarted into the same no-op forever. The supervised process must run the WORKER, and says so. */
export function serviceArgv(inputs: PlanInputs): string[] {
  return [inputs.nodeBin, inputs.scriptPath, "start", "--foreground"];
}

/** The environment the service exports: the token, any explicit hub-url / name overrides, and the
 *  operator's PATH (so the node finds git + the runtime CLIs under a supervisor's minimal PATH). Kept
 *  out of argv so the token never leaks through `ps`.
 *
 *  `DAHRK_SUPERVISED=1` is belt-and-braces with the `--foreground` argv above: either one alone is enough
 *  to keep a supervised process out of daemon mode, and having both means a hand-edited unit that drops
 *  one still cannot produce the restart loop. */
function serviceEnv(inputs: PlanInputs): Record<string, string> {
  return {
    DAHRK_ENROL_TOKEN: inputs.token,
    DAHRK_SUPERVISED: "1",
    ...(inputs.hubUrl ? { DAHRK_HUB_URL: inputs.hubUrl } : {}),
    ...(inputs.name ? { DAHRK_NODE_NAME: inputs.name } : {}),
    ...(inputs.pathEnv ? { PATH: inputs.pathEnv } : {}),
  };
}

/** Escape the five XML entities so a token / URL / name is safe inside a plist `<string>`. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Render the launchd LaunchAgent plist. RunAtLoad starts it now and on login; KeepAlive restarts it if
 *  it exits; ThrottleInterval slows a crash-loop (e.g. a bad token that exits 78) to one try / 10s. */
export function renderLaunchdPlist(inputs: PlanInputs): string {
  const argv = serviceArgv(inputs);
  const env = serviceEnv(inputs);
  const progArgs = argv.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const envEntries = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${progArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(inputs.homeDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(inputs.logDir, "node.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(inputs.logDir, "node.err.log"))}</string>
</dict>
</plist>
`;
}

/** Quote a systemd `Environment=` value only if it needs it (whitespace). Tokens are safe, but a display
 *  name might contain a space, and systemd splits unquoted values on whitespace. */
function systemdEnvValue(v: string): string {
  return /\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

/** Render the systemd *user* unit. Restart=on-failure with a short backoff keeps it up; a bad token
 *  exits 78 (EX_CONFIG), which RestartPreventExitStatus pins as "stop, don't crash-loop" so a misconfig
 *  is visible rather than hammering. network-online ordering avoids a boot-race on the first dial. */
export function renderSystemdUnit(inputs: PlanInputs): string {
  const exec = serviceArgv(inputs)
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(" ");
  const env = serviceEnv(inputs);
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment=${k}=${systemdEnvValue(v)}`)
    .join("\n");
  // Log to the SAME files launchd writes, rather than leaving it to the journal. That makes `dahrk logs`
  // one code path on every host instead of "tail a file here, journalctl there", and it keeps working on
  // hosts where the journal is unavailable or the user has no journal access. `append:` needs systemd 240+
  // (2018) and, importantly, needs the directory to already exist - `runServiceInstall` mkdirs it.
  return `[Unit]
Description=Dahrk node (self-managed edge node)
Documentation=https://dahrk.ai/docs
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
${envLines}
WorkingDirectory=${inputs.homeDir}
StandardOutput=append:${join(inputs.logDir, "node.out.log")}
StandardError=append:${join(inputs.logDir, "node.err.log")}
Restart=on-failure
RestartSec=3
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
`;
}

/** Build the full registration plan for the resolved inputs: the file path, its rendered content, and
 *  the loader / unloader commands for the target supervisor. Pure - no disk, no spawn. */
export function buildPlan(inputs: PlanInputs): ServicePlan {
  if (inputs.manager === "launchd") {
    const filePath = join(inputs.homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    return {
      manager: "launchd",
      label: LAUNCHD_LABEL,
      filePath,
      content: renderLaunchdPlist(inputs),
      // Unload first so a re-install picks up the rewritten plist; a not-loaded unload is a no-op. The
      // `-w` on load also clears the "disabled" flag a previous `dahrk stop` set, so start-after-stop works.
      installCommands: [
        { argv: ["launchctl", "unload", filePath], ignoreFailure: true },
        { argv: ["launchctl", "load", "-w", filePath] },
      ],
      stopCommands: [{ argv: ["launchctl", "unload", "-w", filePath], ignoreFailure: true }],
      uninstallCommands: [{ argv: ["launchctl", "unload", "-w", filePath], ignoreFailure: true }],
      logHint: "dahrk logs -f",
    };
  }
  const filePath = join(inputs.homeDir, ".config", "systemd", "user", SYSTEMD_UNIT);
  const user = userInfo().username;
  return {
    manager: "systemd",
    label: SYSTEMD_UNIT,
    filePath,
    content: renderSystemdUnit(inputs),
    // Reload to see the new unit, enable+start it, then enable linger so it survives logout / boots
    // headless. Linger can be denied without privilege on some hosts, so it is best-effort.
    installCommands: [
      { argv: ["systemctl", "--user", "daemon-reload"] },
      { argv: ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT] },
      { argv: ["loginctl", "enable-linger", user], ignoreFailure: true },
    ],
    // `disable`, not `stop`: a stopped-but-enabled unit comes straight back at the next boot, which is not
    // what anyone means by `dahrk stop`. `dahrk start` re-enables it (`enable --now` above).
    stopCommands: [
      { argv: ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT], ignoreFailure: true },
    ],
    uninstallCommands: [
      { argv: ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT], ignoreFailure: true },
      { argv: ["systemctl", "--user", "daemon-reload"], ignoreFailure: true },
    ],
    logHint: "dahrk logs -f",
  };
}

/** Is the unit on disk the one we would write today? Drives the self-heal in `dahrk start`: when it is
 *  not, the unit is stale (an upgraded client that now needs `--foreground`, a Node path moved by a
 *  `brew upgrade`, a rotated token) and `start` rewrites and reloads it.
 *
 *  This is only safe because the render is DETERMINISTIC - same inputs, byte-identical content. If it were
 *  not, "differs -> rewrite -> reload" would be an infinite restart loop rather than a repair. There is a
 *  test pinning exactly that. */
export function unitIsCurrent(plan: ServicePlan, onDisk: string | undefined): boolean {
  return onDisk === plan.content;
}

/** Where the unit lives for a manager, without rendering it (`status` needs the path, not the content). */
export function unitPath(manager: "launchd" | "systemd", homeDir: string): string {
  return manager === "launchd"
    ? join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
    : join(homeDir, ".config", "systemd", "user", SYSTEMD_UNIT);
}

/** What `dahrk status` reports about the always-on service. `installed` is "the unit file is on disk";
 *  `running` is "the supervisor currently has it up" - the two differ exactly when something is wrong
 *  (installed but dead = a crash-loop or a failed load, which is the case worth surfacing). */
export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
}

/** The query to ask the supervisor whether the unit is up. `launchctl list <label>` prints a plist
 *  containing `"PID" = N;` when running (and exits non-zero when the label is unknown); `systemctl
 *  --user show` prints `ActiveState=`/`MainPID=` lines. Pure: the caller runs it and feeds back stdout. */
export function statusCommand(manager: "launchd" | "systemd"): string[] {
  return manager === "launchd"
    ? ["launchctl", "list", LAUNCHD_LABEL]
    : ["systemctl", "--user", "show", SYSTEMD_UNIT, "-p", "ActiveState", "-p", "MainPID"];
}

/** Parse the supervisor's answer. `installed` is decided by the unit file (passed in), not by the
 *  supervisor: a unit written but never loaded is installed-but-not-running, which is what we want to
 *  say. A non-zero exit means the supervisor does not know the label at all -> not running. */
export function parseServiceStatus(
  manager: "launchd" | "systemd",
  unitExists: boolean,
  probe: { code: number; stdout: string },
): ServiceStatus {
  if (!unitExists) return { installed: false, running: false };
  if (probe.code !== 0) return { installed: true, running: false };
  if (manager === "launchd") {
    // A launchd job that is loaded but not currently up has no "PID" key (only LastExitStatus).
    const pid = Number(/"PID"\s*=\s*(\d+);/.exec(probe.stdout)?.[1]);
    return pid > 0 ? { installed: true, running: true, pid } : { installed: true, running: false };
  }
  const active = /^ActiveState=(.*)$/m.exec(probe.stdout)?.[1]?.trim();
  const pid = Number(/^MainPID=(\d+)$/m.exec(probe.stdout)?.[1]);
  const running = active === "active";
  return running && pid > 0
    ? { installed: true, running: true, pid }
    : { installed: true, running };
}

/** Injectable IO so the install/uninstall shells run without a real host or supervisor. */
export interface ServiceDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  /** The Node binary to exec in the service (`process.execPath`). */
  nodeBin: string;
  /** This client's entry script (`process.argv[1]`), resolved through symlinks before use. */
  scriptPath: string;
  /** Directory launchd logs land in (`~/.dahrk/logs`). */
  logDir: string;
  /** PATH to bake into the service so the daemon resolves git + runtime CLIs like the operator's shell
   *  (`process.env.PATH` at install time). Undefined omits it, falling back to the supervisor's minimal PATH. */
  pathEnv: string | undefined;
  mkdirp: (dir: string) => void;
  writeFile: (path: string, content: string) => void;
  /** Read the unit currently on disk, or undefined when there is none. Drives the self-heal: `start`
   *  compares it against what it would write today and rewrites only when they differ. */
  readFile: (path: string) => string | undefined;
  removeFile: (path: string) => void;
  fileExists: (path: string) => boolean;
  /** Run a loader command; returns its exit code (0 = success). */
  run: (argv: string[]) => number;
  /** Run a probe and capture its stdout (parsed, not shown) - `statusCommand`'s counterpart. */
  capture: (argv: string[]) => { code: number; stdout: string };
  out: (line: string) => void;
}

export interface ServiceInstallInputs {
  token?: string;
  name?: string;
  hubUrl?: string;
}

/** The unsupported-platform message: no launchd / systemd, so point at the pm2 fallback. */
function printUnsupported(out: (line: string) => void): number {
  out("dahrk service is supported on macOS (launchd) and Linux (systemd) only.");
  out("On other platforms, run the node under a process manager such as pm2 (see the README).");
  return 1;
}

/** Run a plan's commands in order; a non-`ignoreFailure` command that exits non-zero aborts and returns
 *  its code. Returns 0 when every essential command succeeded. */
function runCommands(commands: ServiceCommand[], d: ServiceDeps): number {
  for (const cmd of commands) {
    const code = d.run(cmd.argv);
    if (code !== 0 && !cmd.ignoreFailure) {
      d.out(`  command failed (${code}): ${cmd.argv.join(" ")}`);
      return code;
    }
  }
  return 0;
}

/**
 * Install the always-on service: resolve the token, render the unit, write it, and run the loader.
 * Returns the process exit code (0 = installed, 2 = no token, 1 = unsupported host or loader failure).
 */
export async function runServiceInstall(
  inputs: ServiceInstallInputs,
  deps: Partial<ServiceDeps> = {},
): Promise<number> {
  const d = { ...defaultDeps(), ...deps };
  d.out("dahrk service install");
  d.out("");

  const manager = detectManager(d.platform);
  if (manager === "unsupported") return printUnsupported(d.out);

  if (!inputs.token) {
    d.out("No enrolment token: pass --token <token> or set DAHRK_ENROL_TOKEN.");
    d.out("Get one at https://app.dahrk.ai.");
    return 2;
  }

  const plan = buildPlan({
    manager,
    nodeBin: d.nodeBin,
    scriptPath: d.scriptPath,
    token: inputs.token,
    ...(inputs.name ? { name: inputs.name } : {}),
    ...(inputs.hubUrl ? { hubUrl: inputs.hubUrl } : {}),
    ...(d.pathEnv ? { pathEnv: d.pathEnv } : {}),
    homeDir: d.homeDir,
    logDir: d.logDir,
  });

  try {
    // Both managers now log to files in here, and systemd's `append:` FAILS to start the unit if the
    // directory does not already exist - so this is unconditional, not launchd-only.
    d.mkdirp(d.logDir);
    d.mkdirp(dirOf(plan.filePath));
    d.writeFile(plan.filePath, plan.content);
  } catch (e) {
    d.out(`Could not write the service file at ${plan.filePath}: ${(e as Error).message}`);
    return 1;
  }
  d.out(`Wrote ${plan.manager} service: ${plan.filePath}`);

  const code = runCommands(plan.installCommands, d);
  d.out("");
  if (code !== 0) {
    d.out(`The service file is in place but registering it failed (exit ${code}).`);
    d.out("Fix the reported error and re-run `dahrk service install`, or load it yourself.");
    return code;
  }

  d.out("Installed. The node will start on boot and restart on failure.");
  d.out(`  logs:      ${plan.logHint}`);
  d.out("  uninstall: dahrk service uninstall");
  return 0;
}

/** Does this host actually have a usable user-level supervisor? A Linux container almost always has no
 *  systemd user session, so `systemctl --user` fails and daemonising is impossible - we must notice that
 *  and run the worker inline rather than "install" a service that can never start.
 *
 *  `show -p Version` is the probe rather than the more obvious `is-system-running`, because the latter
 *  exits non-zero on a perfectly healthy but `degraded` system - which would send a working host down the
 *  foreground path for no reason. `show` exits 0 whenever there is a user manager to talk to at all. */
export function availabilityCommand(manager: "launchd" | "systemd"): string[] | undefined {
  return manager === "systemd" ? ["systemctl", "--user", "show", "-p", "Version"] : undefined;
}

/** What `dahrk start` decided to do. `foreground` is not a failure: it is every case where daemonising is
 *  impossible or unwise (no supervisor, no user session), where running the worker inline is the honest
 *  thing to do rather than pretending to install a service. */
export type StartOutcome =
  | { kind: "running"; code: 0 }
  | { kind: "foreground"; reason: string }
  | { kind: "error"; code: number };

/**
 * `dahrk start` in daemon mode: make the node be running, and return. Idempotent.
 *
 * It also SELF-HEALS a stale unit: it re-renders what the unit should be and, when that differs from what
 * is on disk, rewrites and reloads it. That covers a client upgrade (units used to invoke bare `start`,
 * which the new `start` would treat as "ensure running" - a restart loop), a Node path moved by a
 * `brew upgrade`, and a rotated token. It is only sound because the render is deterministic; see
 * `unitIsCurrent`.
 */
export async function runNodeStart(
  inputs: ServiceInstallInputs,
  deps: Partial<ServiceDeps> = {},
): Promise<StartOutcome> {
  const d = { ...defaultDeps(), ...deps };

  const manager = detectManager(d.platform);
  if (manager === "unsupported") {
    return { kind: "foreground", reason: "no supported supervisor on this platform (launchd / systemd)" };
  }
  const probeCmd = availabilityCommand(manager);
  if (probeCmd && d.capture(probeCmd).code !== 0) {
    return { kind: "foreground", reason: "no systemd user session on this host (a container, typically)" };
  }

  const filePath = unitPath(manager, d.homeDir);
  const unitExists = d.fileExists(filePath);

  // No token anywhere and no unit to fall back on: there is nothing to enrol with. Say so, exactly once,
  // with where to get one.
  if (!inputs.token && !unitExists) {
    d.out("No enrolment token: pass --token <token> or set DAHRK_ENROL_TOKEN.");
    d.out("Get one at https://app.dahrk.ai.");
    return { kind: "error", code: 2 };
  }

  // The plan's COMMANDS and filePath do not depend on the token - only its rendered content does. So when
  // there is no token we can still load the existing unit (which carries its own token in its env block);
  // we simply must not re-render it. The placeholder never reaches disk on that path.
  const plan = buildPlan({
    manager,
    nodeBin: d.nodeBin,
    scriptPath: d.scriptPath,
    token: inputs.token ?? "-",
    ...(inputs.name ? { name: inputs.name } : {}),
    ...(inputs.hubUrl ? { hubUrl: inputs.hubUrl } : {}),
    ...(d.pathEnv ? { pathEnv: d.pathEnv } : {}),
    homeDir: d.homeDir,
    logDir: d.logDir,
  });
  const canRender = inputs.token !== undefined;
  const current = canRender && unitExists && unitIsCurrent(plan, d.readFile(filePath));

  // Already up, on the unit we would write anyway: do nothing. `start` must be a cheap no-op when the node
  // is healthy, not a restart in disguise.
  const probe = unitExists ? d.capture(statusCommand(manager)) : { code: 1, stdout: "" };
  const status = parseServiceStatus(manager, unitExists, probe);
  if (current && status.running) {
    d.out(`Node is already running${status.pid ? ` (pid ${status.pid})` : ""}.`);
    d.out(`  logs: ${plan.logHint}`);
    return { kind: "running", code: 0 };
  }

  if (canRender && !current) {
    try {
      // systemd's `append:` will not start a unit whose log directory is missing.
      d.mkdirp(d.logDir);
      d.mkdirp(dirOf(plan.filePath));
      d.writeFile(plan.filePath, plan.content);
    } catch (e) {
      d.out(`Could not write the service file at ${plan.filePath}: ${(e as Error).message}`);
      return { kind: "error", code: 1 };
    }
    d.out(unitExists ? `Updated ${plan.manager} service: ${plan.filePath}` : `Installed ${plan.manager} service: ${plan.filePath}`);
  }

  const code = runCommands(plan.installCommands, d);
  if (code !== 0) {
    d.out(`The service file is in place but starting it failed (exit ${code}).`);
    return { kind: "error", code };
  }
  d.out("Node is running. It will start on boot and restart on failure.");
  d.out(`  logs:   ${plan.logHint}`);
  d.out("  stop:   dahrk stop");
  return { kind: "running", code: 0 };
}

/**
 * `dahrk stop`: stop the node now and keep it stopped, without deregistering it - so `dahrk start` brings
 * it back. Returns the process exit code (0 = stopped / nothing to stop, 1 = unsupported host).
 */
export async function runNodeStop(deps: Partial<ServiceDeps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...deps };

  const manager = detectManager(d.platform);
  if (manager === "unsupported") return printUnsupported(d.out);

  // Removal / stopping never needs a real token; the placeholder keeps the builder's shape.
  const plan = buildPlan({
    manager,
    nodeBin: d.nodeBin,
    scriptPath: d.scriptPath,
    token: "-",
    homeDir: d.homeDir,
    logDir: d.logDir,
  });

  if (!d.fileExists(plan.filePath)) {
    d.out("No service installed, so there is nothing to stop.");
    d.out("If you are running a node in a terminal (`dahrk start --foreground`), stop it with Ctrl-C.");
    return 0;
  }

  runCommands(plan.stopCommands, d);
  d.out("Node stopped. It will stay stopped across reboots until you run `dahrk start`.");
  return 0;
}

/**
 * Remove the service: stop + deregister it, then delete the unit file. A missing service is a no-op
 * success. Returns the process exit code (0 = removed / nothing to do, 1 = unsupported host).
 */
export async function runServiceUninstall(deps: Partial<ServiceDeps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...deps };
  d.out("dahrk service uninstall");
  d.out("");

  const manager = detectManager(d.platform);
  if (manager === "unsupported") return printUnsupported(d.out);

  // Token is irrelevant to removal; a placeholder keeps the plan builder's shape without leaking a real one.
  const plan = buildPlan({
    manager,
    nodeBin: d.nodeBin,
    scriptPath: d.scriptPath,
    token: "-",
    homeDir: d.homeDir,
    logDir: d.logDir,
  });

  if (!d.fileExists(plan.filePath)) {
    d.out(`No service installed (${plan.filePath} not found). Nothing to do.`);
    return 0;
  }

  // Deregister first (best-effort), then delete the file so it does not reload on next boot.
  runCommands(plan.uninstallCommands, d);
  try {
    d.removeFile(plan.filePath);
  } catch (e) {
    d.out(`Deregistered, but could not delete ${plan.filePath}: ${(e as Error).message}`);
    return 1;
  }
  d.out(`Removed ${plan.filePath}. The node will no longer start on boot.`);
  return 0;
}

/** The parent directory of a path (so the shell can mkdir -p before writing the unit). */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? path : path.slice(0, i);
}

/** Resolve `process.argv[1]` through any symlink so the unit points at the real script, not the bin
 *  symlink an npm / Homebrew global install exposes. Falls back to the raw path if it cannot resolve. */
function resolveScriptPath(): string {
  const argv1 = process.argv[1] ?? "";
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}

/**
 * Pick a Node path for the unit that will still exist after the operator upgrades Node.
 *
 * Homebrew installs Node into a VERSIONED Cellar directory (`.../Cellar/node/26.5.0/bin/node`) and
 * symlinks it from a stable one (`.../opt/node/bin/node`). `process.execPath` resolves symlinks, so it
 * hands us the versioned path - and `brew upgrade node` deletes that directory. The unit would then
 * point at a binary that no longer exists, and launchd/systemd would restart it into that same failure
 * every `ThrottleInterval` forever: a node that silently stops serving Jobs after an unrelated upgrade.
 *
 * So when `execPath` is a Cellar path, prefer a stable alias that CURRENTLY resolves to the very same
 * binary (verified, never assumed). Any other layout (system Node, nvm, a plain tarball) has no such
 * alias and is returned unchanged.
 */
export function stableNodeBin(execPath: string, realpath: (p: string) => string | undefined): string {
  const m = /^(?<prefix>.*)\/Cellar\/(?<formula>node(?:@[\d.]+)?)\/[^/]+\/bin\/node$/.exec(execPath);
  const { prefix, formula } = m?.groups ?? {};
  if (!prefix || !formula) return execPath;
  const candidates = [`${prefix}/opt/${formula}/bin/node`, `${prefix}/bin/node`];
  return candidates.find((c) => realpath(c) === execPath) ?? execPath;
}

const realpathOrUndefined = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

const defaultDeps = (): ServiceDeps => ({
  platform: osPlatform(),
  homeDir: homedir(),
  // Not `process.execPath` raw: that is the versioned Homebrew Cellar path, which the next
  // `brew upgrade node` deletes out from under the unit. See `stableNodeBin`.
  nodeBin: stableNodeBin(process.execPath, realpathOrUndefined),
  scriptPath: resolveScriptPath(),
  logDir: resolveLogDir(process.env),
  // Snapshot the operator's PATH at install time so the daemon finds git + the runtime CLIs (Homebrew /
  // npm-global bins) that a supervisor's minimal PATH would otherwise hide.
  pathEnv: process.env.PATH,
  mkdirp: (dir) => void mkdirSync(dir, { recursive: true }),
  // The unit's environment block carries the enrolment token, so the file is a secret: write it
  // owner-only. `writeFileSync`'s `mode` applies only when it CREATES the file, so chmod explicitly
  // too - re-installing over a unit an older client left at 0644 must tighten it, not keep it.
  writeFile: (path, content) => {
    writeFileSync(path, content, { mode: UNIT_FILE_MODE });
    chmodSync(path, UNIT_FILE_MODE);
  },
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  removeFile: (path) => rmSync(path, { force: true }),
  fileExists: (path) => existsSync(path),
  run: (argv) => {
    const [cmd, ...args] = argv;
    try {
      execFileSync(cmd as string, args, { stdio: "inherit" });
      return 0;
    } catch (e) {
      const status = (e as { status?: unknown }).status;
      return typeof status === "number" ? status : 1;
    }
  },
  capture: (argv) => {
    const [cmd, ...args] = argv;
    try {
      // Parsed, not shown - so capture rather than inherit. stderr is dropped: `launchctl list` on an
      // unknown label writes there, and the exit code already tells us what we need.
      const stdout = execFileSync(cmd as string, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { code: 0, stdout };
    } catch (e) {
      const status = (e as { status?: unknown }).status;
      return { code: typeof status === "number" ? status : 1, stdout: "" };
    }
  },
  out: (line) => void process.stdout.write(`${line}\n`),
});
