/**
 * `dahrk update` - the local, user-initiated self-update to the latest published client. The operator
 * runs it themselves on their own machine, so there is no hub involvement and no trust boundary: it is
 * the plain "upgrade me" counterpart to a future hub-triggered remote upgrade (DHK-341), which reuses
 * this same local path.
 *
 * It answers "am I current, and if not, upgrade me": read this build's version, ask the npm registry
 * for the latest published one (the single source of "latest" across every channel - Homebrew's formula
 * points at the same npm tarball), and compare. If current, it is a no-op. If behind, it detects how the
 * client was installed (npm / Homebrew / curl) from the resolved path of its own bin and does the right
 * thing: run the package manager where that is safe to automate, or print the exact upgrade command when
 * it cannot tell or cannot safely run it. `--check` reports `current -> latest` without applying.
 *
 * The decision logic is pure (channel inference, version comparison, command selection) so it unit-tests
 * without a network or a real install; `runUpdate` is the thin IO shell that fetches, prints, and spawns.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { nodeIsRunning, runNodeRestart } from "./service.js";
import { arrow, confirm, dim, hint, isInteractive, kv, out as uiOut, verdict } from "./ui.js";

/** How this client was installed, which decides how it upgrades. `unknown` covers a curl install.sh, a
 *  run-from-source checkout, or anything we cannot positively identify - we print the command, never guess. */
export type Channel = "npm" | "homebrew" | "unknown";

/** The npm registry dist-tag endpoint that names the latest published version. This is the shared
 *  "latest" source for every channel: the Homebrew formula's `url` resolves to the same npm tarball, and
 *  the curl installer pulls from npm too, so one registry read answers "what is the newest release?". */
export const LATEST_URL = "https://registry.npmjs.org/dahrk-node/latest";

/** The exact per-channel upgrade commands, as a copy-paste line each. Re-running an install upgrades in
 *  place, so these double as the printed instructions when we cannot (or should not) run them ourselves. */
export const CHANNEL_COMMANDS = {
  npm: "npm install -g dahrk-node@latest",
  homebrew: "brew upgrade dahrkai/tap/dahrk",
  curl: "curl -fsSL https://dahrk.ai/install.sh | sh",
} as const;

/** The package-manager invocation that upgrades a given channel in place: argv (to spawn) and the same
 *  as a display string (to print). `unknown` has no single command - the caller prints all channels. */
export function upgradeCommand(channel: Channel): { argv: string[]; display: string } | null {
  switch (channel) {
    case "npm":
      return { argv: ["npm", "install", "-g", "dahrk-node@latest"], display: CHANNEL_COMMANDS.npm };
    case "homebrew":
      return { argv: ["brew", "upgrade", "dahrkai/tap/dahrk"], display: CHANNEL_COMMANDS.homebrew };
    case "unknown":
      return null;
  }
}

/** Infer the install channel from the resolved path of this client's bin. A global npm install resolves
 *  under `node_modules/dahrk-node`; a Homebrew install symlinks its bin into the Cellar. npm is checked
 *  first because a Homebrew-provided Node still installs global npm packages under the Homebrew prefix -
 *  those are npm installs and upgrade via npm, not `brew`. Anything else is `unknown`. */
export function detectChannel(binPath: string | undefined): Channel {
  if (!binPath) return "unknown";
  let resolved = binPath;
  try {
    resolved = realpathSync(binPath);
  } catch {
    // Use the raw path if it cannot be resolved (e.g. already deleted); the patterns still apply.
  }
  if (/[\\/]node_modules[\\/]dahrk-node[\\/]/.test(resolved)) return "npm";
  if (/[\\/](Cellar|homebrew)[\\/]/.test(resolved)) return "homebrew";
  return "unknown";
}

/** Parse a semver core (major.minor.patch, ignoring any `-prerelease`/`+build`) into a numeric tuple, or
 *  null when it is not a recognisable version. */
function core(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim().replace(/^v/, ""));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True iff `latest` is strictly newer than `current` by semver core. Either version being unparseable
 *  yields false: we never claim an update we cannot actually verify. Prereleases are compared by core
 *  only, which is sufficient here (releases are plain `x.y.z`). */
export function isNewer(latest: string, current: string): boolean {
  const a = core(latest);
  const b = core(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

/** What the upgrade command produced: its exit code and its (captured) output. See {@link spawnUpgrade}. */
export interface UpgradeResult {
  code: number;
  output: string;
}

/** Injectable IO so `runUpdate` exercises without a network or a real package manager. */
export interface UpdateDeps {
  /** This client's bin path (`process.argv[1]`), resolved to infer the install channel. */
  binPath?: string;
  /** Fetch the latest published version; throws on a network/registry failure. */
  fetchLatest: () => Promise<string>;
  /** Spawn the upgrade command, capturing what it printed. */
  runUpgrade: (argv: string[]) => UpgradeResult;
  /** Is a node actually running on this host right now? Decides whether the "you must restart" advice is
   *  worth saying at all: on a machine with no node up, it is noise about a problem nobody has. */
  nodeRunning: () => boolean;
  /** Is there a human here to answer a question? False under a pipe, in CI, or from the curl installer. */
  interactive: () => boolean;
  /** Ask a yes/no question, defaulting to yes. */
  confirm: (question: string) => Promise<boolean>;
  /** Restart the node. Returns its exit code. */
  restart: () => Promise<number>;
  out: (line: string) => void;
}

export interface UpdateInputs {
  /** This build's version (the compiled `CLIENT_VERSION`). */
  currentVersion: string;
  /** `--check`: report whether an update is available without applying it. */
  check: boolean;
  /** `--verbose`: show the package manager's own output even when it succeeds. */
  verbose?: boolean;
}

/** Print the per-channel upgrade commands - the fallback when we cannot tell how the client was installed. */
function printChannelCommands(out: (line: string) => void): void {
  out(kv("npm", CHANNEL_COMMANDS.npm));
  out(kv("Homebrew", CHANNEL_COMMANDS.homebrew));
  out(kv("curl", CHANNEL_COMMANDS.curl));
}

/**
 * Run the update: read current vs latest, then either report a no-op, report availability (`--check`),
 * run the channel's upgrade command, or print it when the channel is unknown. Returns the process exit
 * code: 0 when current / reported / upgraded, the upgrade command's own code on a run, and 1 when the
 * latest version could not be determined.
 */
export async function runUpdate(inputs: UpdateInputs, deps: Partial<UpdateDeps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...deps };
  const current = inputs.currentVersion;

  d.out("");

  let latest: string;
  try {
    latest = await d.fetchLatest();
  } catch (e) {
    d.out(verdict("fail", `Could not determine the latest version: ${(e as Error).message}`));
    d.out("");
    d.out(hint(`You are on ${current}. See https://www.npmjs.com/package/dahrk-node for releases.`));
    return 1;
  }

  if (!isNewer(latest, current)) {
    d.out(verdict("ok", `Already on the latest version (${current}).`));
    return 0;
  }

  d.out(verdict("warn", `Update available: ${current} ${arrow()} ${latest}`));
  const channel = detectChannel(d.binPath);
  const cmd = upgradeCommand(channel);

  // `--check`: report availability and how to apply it, but change nothing.
  if (inputs.check) {
    d.out("");
    if (cmd) {
      d.out(hint(`Run \`dahrk update\` to upgrade (${channel}: ${cmd.display}).`));
    } else {
      d.out(hint("Run `dahrk update`, or upgrade with the command for your install channel:"));
      printChannelCommands(d.out);
    }
    return 0;
  }

  // Unknown channel: we cannot safely automate the upgrade, so print the exact commands instead.
  if (!cmd) {
    d.out("");
    d.out(hint("Could not tell how this client was installed. Upgrade with the command for your channel:"));
    printChannelCommands(d.out);
    return 0;
  }

  // Known channel: run the package manager in place.
  d.out("");
  d.out(hint(`Upgrading via ${channel}: ${cmd.display}`));
  const { code, output } = d.runUpgrade(cmd.argv);
  d.out("");

  if (code !== 0) {
    d.out(verdict("fail", `Upgrade failed (exit ${code}).`));
    // On failure the package manager's output is the entire point, so it is printed whether or not
    // --verbose was asked for.
    for (const line of output.split("\n")) if (line.trim()) d.out(`    ${dim(line)}`);
    d.out("");
    d.out(hint(`Run it yourself to retry: ${cmd.display}`));
    return code;
  }

  if (inputs.verbose) for (const line of output.split("\n")) if (line.trim()) d.out(`    ${dim(line)}`);
  d.out(verdict("ok", `Upgraded to ${latest}.`));
  await offerRestart(d);
  return 0;
}

/**
 * The upgrade landed on disk, but a node that is already running is still executing the OLD build: a
 * long-lived daemon does not re-exec itself because npm replaced its files underneath it. So it has to be
 * restarted, and until it is, `dahrk status` will cheerfully report the new version while the node serving
 * Jobs is the old one.
 *
 * This used to advise `dahrk start`, which does not work: `start` on a running node takes the "already
 * running" branch and returns without touching it, so the operator would follow the instruction, see a
 * reassuring message, and still be on the old build. `restart` is the verb that actually does it.
 *
 * Better still, do it for them. There is a human at the terminal (they just typed `dahrk update`), so ask -
 * the same courtesy `dahrk start` already extends when it notices an update is available. A node that is not
 * running needs no advice at all, and a non-interactive caller gets the correct command instead of a prompt
 * nobody is there to answer.
 */
async function offerRestart(d: UpdateDeps): Promise<void> {
  if (!d.nodeRunning()) return;

  if (!d.interactive()) {
    d.out(hint("A node is running on the old build. Run `dahrk restart` to pick this up."));
    return;
  }
  d.out("");
  if (!(await d.confirm("A node is running on the old build. Restart it now?"))) {
    d.out(hint("Left running on the old build. Run `dahrk restart` when you are ready."));
    return;
  }
  const code = await d.restart();
  // A restart that refused (a stage in flight) or failed has already said why. Do not paper over it with a
  // success line: the upgrade landed, but the node is still serving the old build, and that is the fact.
  if (code !== 0) d.out(hint("The node is still on the old build. Run `dahrk restart` once it is free."));
  else d.out(verdict("ok", "Node restarted on the new build."));
}

/** Fetch the latest published version from the npm registry's `latest` dist-tag. Exported so the passive
 *  update check (`update-check.ts`) asks the same question of the same source, rather than growing a second
 *  notion of "latest" that could disagree with `dahrk update`.
 *
 *  `signal` bounds the wait. `dahrk update` is a foreground command the operator is watching, so it passes
 *  none; the passive check runs on the path of `dahrk start` and must never make a start hang on a slow
 *  registry, so it passes a short timeout. */
export async function fetchLatestVersion(signal?: AbortSignal): Promise<string> {
  const res = await fetch(LATEST_URL, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !body.version) throw new Error("registry returned no version");
  return body.version;
}

/**
 * Spawn an upgrade command, capturing its output rather than inheriting it.
 *
 * A successful `npm install -g` is not interesting, and npm does not agree: it prints a wall of ERESOLVE
 * peer-dependency warnings about our own transitive `zod` versions, which is alarming, is not actionable,
 * and is not a problem. The operator asked to be upgraded, not to be shown npm's working. So the output is
 * captured and thrown away on success, and printed in full on failure - where it is the only thing that
 * matters, and where today it was already being drowned in the same noise. `--verbose` opts back in.
 */
function spawnUpgrade(argv: string[]): UpgradeResult {
  const [cmd, ...args] = argv;
  try {
    const stdout = execFileSync(cmd as string, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: stdout };
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    const { stdout, stderr } = e as { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: typeof status === "number" ? status : 1,
      output: `${stdout?.toString() ?? ""}${stderr?.toString() ?? ""}`,
    };
  }
}

const defaultDeps = (): UpdateDeps => ({
  binPath: process.argv[1],
  fetchLatest: fetchLatestVersion,
  runUpgrade: spawnUpgrade,
  nodeRunning: nodeIsRunning,
  interactive: isInteractive,
  confirm,
  // No inputs: the installed unit already carries this node's token and overrides in its env block, so a
  // restart re-registers exactly what was there before, with the new client on disk behind it. `desired` is
  // untouched on purpose - the node was running, and it still is.
  restart: async () => {
    const outcome = await runNodeRestart({});
    if (outcome.kind === "running") return 0;
    return outcome.kind === "error" ? outcome.code : 1;
  },
  out: uiOut,
});
