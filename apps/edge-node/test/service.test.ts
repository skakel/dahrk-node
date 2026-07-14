import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availabilityCommand,
  detectManager,
  renderLaunchdPlist,
  renderSystemdUnit,
  buildPlan,
  foreignNodePid,
  runNodeRestart,
  runNodeStart,
  runNodeStop,
  liveNodePid,
  BUSY_NODE,
  runServiceInstall,
  STOP_FOREIGN_NODE,
  runServiceUninstall,
  serviceArgv,
  unitIsCurrent,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  UNIT_FILE_MODE,
  stableNodeBin,
  parseServiceStatus,
  statusCommand,
  unitPath,
  type PlanInputs,
  type ServiceDeps,
} from "../src/service.ts";

const BASE: PlanInputs = {
  manager: "launchd",
  nodeBin: "/usr/local/bin/node",
  scriptPath: "/usr/local/lib/node_modules/dahrk-node/dist/main.js",
  homeDir: "/Users/me",
  logDir: "/Users/me/.dahrk/logs",
};

test("detectManager: darwin->launchd, linux->systemd, else unsupported", () => {
  assert.equal(detectManager("darwin"), "launchd");
  assert.equal(detectManager("linux"), "systemd");
  assert.equal(detectManager("win32"), "unsupported");
});

test("renderLaunchdPlist: runs node+script start, carries NO token anywhere, keep-alive + logs", () => {
  const plist = renderLaunchdPlist(BASE);
  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  // ProgramArguments is node + the resolved script + `start`.
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>start<\/string>/);
  // The token is in NEITHER argv nor the env block. It lives only in ~/.dahrk/node.json, because a copy
  // in here outranks the disk (`resolveEnrolToken`) and cannot be updated by re-enrolling - which is how
  // a node ends up presenting a revoked token on every boot forever.
  assert.doesNotMatch(plist, /DAHRK_ENROL_TOKEN/);
  assert.doesNotMatch(plist, /sket_/);
  assert.match(plist, /<key>DAHRK_SUPERVISED<\/key>\s*<string>1<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /node\.err\.log/);
});

test("renderLaunchdPlist: only sets hub-url / name env when provided, and XML-escapes values", () => {
  const bare = renderLaunchdPlist(BASE);
  assert.doesNotMatch(bare, /DAHRK_HUB_URL/);
  assert.doesNotMatch(bare, /DAHRK_NODE_NAME/);

  const full = renderLaunchdPlist({ ...BASE, hubUrl: "ws://h:1", name: "a & b" });
  assert.match(full, /<key>DAHRK_HUB_URL<\/key>\s*<string>ws:\/\/h:1<\/string>/);
  assert.match(full, /<key>DAHRK_NODE_NAME<\/key>\s*<string>a &amp; b<\/string>/);
});

test("renderSystemdUnit: on-failure restart, 78 pinned as stop, no token anywhere, network ordering", () => {
  const unit = renderSystemdUnit({ ...BASE, manager: "systemd" });
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/node \/usr\/local\/lib\/node_modules\/dahrk-node\/dist\/main\.js start/);
  // Same rule as the plist: the unit is not a second home for the token.
  assert.doesNotMatch(unit, /DAHRK_ENROL_TOKEN/);
  assert.match(unit, /Environment=DAHRK_SUPERVISED=1/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /RestartPreventExitStatus=78/);
  assert.match(unit, /Wants=network-online\.target/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("renderSystemdUnit: quotes an Environment value that contains whitespace", () => {
  const unit = renderSystemdUnit({ ...BASE, manager: "systemd", name: "my mac" });
  assert.match(unit, /Environment=DAHRK_NODE_NAME="my mac"/);
});

test("bakes the operator's PATH into the env block so the daemon finds git + runtime CLIs", () => {
  const path = "/opt/homebrew/bin:/usr/bin:/bin";
  // launchd: PATH is a key in EnvironmentVariables, not a ProgramArgument.
  const plist = renderLaunchdPlist({ ...BASE, pathEnv: path });
  assert.match(plist, new RegExp(`<key>PATH</key>\\s*<string>${path.replace(/\//g, "\\/")}</string>`));
  // systemd: PATH via Environment=.
  const unit = renderSystemdUnit({ ...BASE, manager: "systemd", pathEnv: path });
  assert.match(unit, new RegExp(`Environment=PATH=${path.replace(/\//g, "\\/")}`));
  // Unset PATH omits it entirely rather than exporting an empty one.
  assert.doesNotMatch(renderLaunchdPlist(BASE), /<key>PATH<\/key>/);
  assert.doesNotMatch(renderSystemdUnit({ ...BASE, manager: "systemd" }), /Environment=PATH=/);
});

test("buildPlan: launchd path + launchctl load/unload commands", () => {
  const plan = buildPlan(BASE);
  assert.equal(plan.filePath, `/Users/me/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
  assert.deepEqual(plan.installCommands.at(-1)?.argv, ["launchctl", "load", "-w", plan.filePath]);
  assert.deepEqual(plan.uninstallCommands[0]?.argv, ["launchctl", "unload", "-w", plan.filePath]);
});

test("buildPlan: systemd path + systemctl --user enable/disable, linger is best-effort", () => {
  const plan = buildPlan({ ...BASE, manager: "systemd" });
  assert.equal(plan.filePath, `/Users/me/.config/systemd/user/${SYSTEMD_UNIT}`);
  assert.deepEqual(plan.installCommands[1]?.argv, ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT]);
  const linger = plan.installCommands.find((c) => c.argv[0] === "loginctl");
  assert.equal(linger?.ignoreFailure, true);
  // Both managers now write the same log files, so there is one hint on every platform.
  assert.equal(plan.logHint, "dahrk logs -f");
});

/** A recording harness: capture printed lines, written files, and the loader commands that ran. */
function harness(over: Partial<ServiceDeps>): {
  deps: Partial<ServiceDeps>;
  lines: string[];
  writes: Array<{ path: string; content: string }>;
  ran: string[][];
  removed: string[];
} {
  const lines: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const ran: string[][] = [];
  const removed: string[] = [];
  const deps: Partial<ServiceDeps> = {
    platform: "darwin",
    homeDir: "/Users/me",
    nodeBin: "/usr/local/bin/node",
    scriptPath: "/usr/local/lib/node_modules/dahrk-node/dist/main.js",
    logDir: "/Users/me/.dahrk/logs",
    pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
    mkdirp: () => {},
    writeFile: (path, content) => writes.push({ path, content }),
    removeFile: (path) => removed.push(path),
    fileExists: () => true,
    run: (argv) => {
      ran.push(argv);
      return { code: 0, output: "" };
    },
    // Hermetic by default. Without these the shells fall through to the REAL deps and a unit test would
    // shell out to the developer's launchctl and read their actual ~/.dahrk/jobs.json.
    capture: () => ({ code: 1, stdout: "" }),
    readFile: () => undefined,
    isAlive: () => false,
    inFlightJobs: () => [],
    out: (l) => lines.push(l),
    ...over,
  };
  return { deps, lines, writes, ran, removed };
}

test("install: writes the plist and runs the loader; exit 0", async () => {
  const { deps, writes, ran } = harness({});
  const code = await runServiceInstall({ token: "sket_abc" }, deps);
  assert.equal(code, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0]!.path, /Library\/LaunchAgents\/ai\.dahrk\.node\.plist$/);
  // The token was supplied, and is still not written into the unit: `dahrk start` puts it on disk instead.
  assert.doesNotMatch(writes[0]!.content, /sket_abc/);
  // The harness's PATH is snapshotted into the unit so the daemon resolves git + runtime CLIs.
  assert.match(writes[0]!.content, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin/);
  assert.ok(ran.some((c) => c[0] === "launchctl" && c[1] === "load"));
});

test("install: no token is a config error (exit 2), writes nothing", async () => {
  const { deps, writes } = harness({});
  const code = await runServiceInstall({}, deps);
  assert.equal(code, 2);
  assert.equal(writes.length, 0);
});

test("install: an unsupported platform exits 1 and points at pm2", async () => {
  const { deps, lines, writes } = harness({ platform: "win32" });
  const code = await runServiceInstall({ token: "t" }, deps);
  assert.equal(code, 1);
  assert.equal(writes.length, 0);
  assert.ok(lines.some((l) => /pm2/.test(l)));
});

test("install: a failed loader command surfaces its non-zero exit", async () => {
  const { deps } = harness({ run: () => ({ code: 3, output: "boom" }), platform: "linux" });
  const code = await runServiceInstall({ token: "t" }, deps);
  assert.equal(code, 3);
});

test("install (systemd): the best-effort linger failure does not fail the install", async () => {
  // loginctl is the only failing command; because it is ignoreFailure, install still succeeds.
  const { deps } = harness({
    platform: "linux",
    run: (argv) => ({ code: argv[0] === "loginctl" ? 1 : 0, output: "" }),
  });
  const code = await runServiceInstall({ token: "t" }, deps);
  assert.equal(code, 0);
});

test("uninstall: deregisters and deletes the unit; exit 0", async () => {
  const { deps, ran, removed } = harness({});
  const code = await runServiceUninstall(deps);
  assert.equal(code, 0);
  assert.ok(ran.some((c) => c[0] === "launchctl" && c[1] === "unload"));
  assert.equal(removed.length, 1);
  assert.match(removed[0]!, /ai\.dahrk\.node\.plist$/);
});

test("uninstall: a missing service is a no-op success and removes nothing", async () => {
  const { deps, removed } = harness({ fileExists: () => false });
  const code = await runServiceUninstall(deps);
  assert.equal(code, 0);
  assert.equal(removed.length, 0);
});

// --- The unit file is a secret, and must survive a Node upgrade -------------------------------

test("stableNodeBin: a Homebrew Cellar path becomes the stable opt symlink that survives `brew upgrade`", () => {
  // `brew upgrade node` deletes .../Cellar/node/26.5.0, so a unit pinned to it crash-loops forever.
  const cellar = "/opt/homebrew/Cellar/node/26.5.0/bin/node";
  const realpath = (p: string): string | undefined =>
    p === "/opt/homebrew/opt/node/bin/node" || p === "/opt/homebrew/bin/node" ? cellar : undefined;
  assert.equal(stableNodeBin(cellar, realpath), "/opt/homebrew/opt/node/bin/node");
});

test("stableNodeBin: a versioned formula (node@22) maps to its own opt symlink, not plain `node`", () => {
  const cellar = "/opt/homebrew/Cellar/node@22/22.1.0/bin/node";
  const realpath = (p: string): string | undefined =>
    p === "/opt/homebrew/opt/node@22/bin/node" ? cellar : "/some/other/node";
  assert.equal(stableNodeBin(cellar, realpath), "/opt/homebrew/opt/node@22/bin/node");
});

test("stableNodeBin: an alias that resolves elsewhere is never used (verified, not assumed)", () => {
  // A stale/hand-made symlink pointing at a DIFFERENT node must not be substituted.
  const cellar = "/opt/homebrew/Cellar/node/26.5.0/bin/node";
  assert.equal(stableNodeBin(cellar, () => "/usr/local/bin/node"), cellar);
});

test("stableNodeBin: non-Homebrew layouts (system node, nvm) are returned unchanged", () => {
  const nvm = "/Users/x/.nvm/versions/node/v22.1.0/bin/node";
  assert.equal(stableNodeBin(nvm, () => nvm), nvm, "nvm has no stable alias to prefer");
  assert.equal(stableNodeBin("/usr/bin/node", () => "/usr/bin/node"), "/usr/bin/node");
});

test("install: the unit carries the token, so it is written 0600 and never world-readable", async () => {
  const written: Array<{ path: string; mode?: number }> = [];
  const deps: Partial<ServiceDeps> = {
    platform: "darwin",
    homeDir: "/home/u",
    nodeBin: "/usr/bin/node",
    scriptPath: "/opt/dahrk/main.js",
    logDir: "/home/u/.dahrk/logs",
    mkdirp: () => {},
    writeFile: (path) => void written.push({ path }),
    run: () => ({ code: 0, output: "" }),
    inFlightJobs: () => [],
    out: () => {},
  };
  const code = await runServiceInstall({ token: "sket_abc" }, deps);
  assert.equal(code, 0);
  // The real `writeFile` dep is what enforces the mode; assert the constant it uses is owner-only, so a
  // change to it fails here rather than silently widening a file that holds a live token.
  assert.equal(UNIT_FILE_MODE, 0o600);
  assert.equal(written[0]?.path, "/home/u/Library/LaunchAgents/ai.dahrk.node.plist");
});

// --- Reading the supervisor back, for `dahrk status` ------------------------------------------

test("parseServiceStatus: launchd reports the pid when up, and not-running when the job has no PID", () => {
  const up = { code: 0, stdout: '{\n\t"PID" = 79747;\n\t"Label" = "ai.dahrk.node";\n}' };
  assert.deepEqual(parseServiceStatus("launchd", true, up), { installed: true, running: true, pid: 79747 });
  const down = { code: 0, stdout: '{\n\t"LastExitStatus" = 78;\n}' };
  assert.deepEqual(parseServiceStatus("launchd", true, down), { installed: true, running: false });
});

test("parseServiceStatus: systemd is running only when ActiveState=active", () => {
  const up = { code: 0, stdout: "ActiveState=active\nMainPID=4242\n" };
  assert.deepEqual(parseServiceStatus("systemd", true, up), { installed: true, running: true, pid: 4242 });
  const failed = { code: 0, stdout: "ActiveState=failed\nMainPID=0\n" };
  assert.deepEqual(parseServiceStatus("systemd", true, failed), { installed: true, running: false });
});

test("parseServiceStatus: a unit on disk the supervisor does not know is installed-but-down", () => {
  // The state worth surfacing: the file is there, so it LOOKS installed, but nothing is keeping it up.
  assert.deepEqual(parseServiceStatus("launchd", true, { code: 113, stdout: "" }), {
    installed: true,
    running: false,
  });
  assert.deepEqual(parseServiceStatus("launchd", false, { code: 113, stdout: "" }), {
    installed: false,
    running: false,
  });
});

test("unitPath / statusCommand: the paths and probes match what install actually registered", () => {
  assert.equal(unitPath("launchd", "/home/u"), "/home/u/Library/LaunchAgents/ai.dahrk.node.plist");
  assert.equal(unitPath("systemd", "/home/u"), "/home/u/.config/systemd/user/dahrk-node.service");
  assert.deepEqual(statusCommand("launchd"), ["launchctl", "list", LAUNCHD_LABEL]);
  assert.deepEqual(statusCommand("systemd").slice(0, 3), ["systemctl", "--user", "show"]);
});

// --- The daemon reshuffle: `start` now means "ensure running", so the supervised process must run the
// --- WORKER. A unit that invoked bare `start` would have the daemon see itself running, exit, and be
// --- restarted into the same no-op every ThrottleInterval - i.e. a node that silently stops serving Jobs.

test("the unit runs the WORKER, not `start` - else the daemon would restart-loop on itself", () => {
  assert.deepEqual(serviceArgv(BASE), [BASE.nodeBin, BASE.scriptPath, "start", "--foreground"]);

  const plist = renderLaunchdPlist(BASE);
  assert.match(plist, /<string>--foreground<\/string>/);
  assert.match(plist, /<key>DAHRK_SUPERVISED<\/key>\s*\n\s*<string>1<\/string>/);

  const unit = renderSystemdUnit({ ...BASE, manager: "systemd" });
  assert.match(unit, /^ExecStart=.*main\.js start --foreground$/m);
  assert.match(unit, /^Environment=DAHRK_SUPERVISED=1$/m);
});

test("systemd logs to the same files as launchd, so `dahrk logs` is one thing everywhere", () => {
  const unit = renderSystemdUnit({ ...BASE, manager: "systemd" });
  assert.match(unit, /^StandardOutput=append:\/Users\/me\/\.dahrk\/logs\/node\.out\.log$/m);
  assert.match(unit, /^StandardError=append:\/Users\/me\/\.dahrk\/logs\/node\.err\.log$/m);
});

test("the render is DETERMINISTIC - the self-heal compares content, so drift here is an infinite loop", () => {
  // `start` rewrites and reloads the unit whenever it differs from what it would write today. If the
  // render were not byte-stable, every start would "repair" the unit and restart the node, forever.
  const a = renderLaunchdPlist(BASE);
  const b = renderLaunchdPlist({ ...BASE });
  assert.equal(a, b);
  assert.equal(renderSystemdUnit({ ...BASE, manager: "systemd" }), renderSystemdUnit({ ...BASE, manager: "systemd" }));

  const plan = buildPlan(BASE);
  assert.equal(unitIsCurrent(plan, a), true);
  assert.equal(unitIsCurrent(plan, undefined), false, "no unit on disk is not current");
  assert.equal(unitIsCurrent(plan, a.replace("--foreground", "")), false, "a pre-upgrade unit is stale");
});

test("a unit from an older client, with the token baked in, is stale - so `start` rewrites it without one", () => {
  // This is the migration, and it needs no migration code. A unit written before the token moved to disk
  // carries `DAHRK_ENROL_TOKEN` in its env block; what we render today does not; so they differ, so the
  // ordinary "is the unit on disk the one I would write?" self-heal rewrites it and the stale token - the
  // copy that was shadowing the disk and stranding the node on a revoked credential - goes away with it.
  const legacy = renderLaunchdPlist(BASE).replace(
    "<key>DAHRK_SUPERVISED</key>",
    "<key>DAHRK_ENROL_TOKEN</key>\n    <string>sket_revoked</string>\n    <key>DAHRK_SUPERVISED</key>",
  );
  assert.match(legacy, /DAHRK_ENROL_TOKEN/); // the unit we are migrating FROM
  assert.equal(unitIsCurrent(buildPlan(BASE), legacy), false);
});

test("stopCommands make a stop STICK - a stop that undid itself at the next boot is not a stop", () => {
  // launchd re-loads an agent at the next login unless it is unloaded with -w; a systemd unit that is
  // merely `stop`ped is still enabled, so it comes back at the next boot.
  const launchd = buildPlan(BASE);
  assert.deepEqual(launchd.stopCommands[0]?.argv, [
    "launchctl",
    "unload",
    "-w",
    `/Users/me/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
  ]);

  const systemd = buildPlan({ ...BASE, manager: "systemd" });
  assert.deepEqual(systemd.stopCommands[0]?.argv, ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]);
});

test("availabilityCommand: systemd is probed with `show`, not `is-system-running`", () => {
  // `is-system-running` exits non-zero on a healthy-but-`degraded` host, which would send a perfectly good
  // machine down the foreground fallback for no reason.
  assert.deepEqual(availabilityCommand("systemd"), ["systemctl", "--user", "show", "-p", "Version"]);
  assert.equal(availabilityCommand("launchd"), undefined);
});

const LOCK = "/Users/me/.dahrk/node.pid";

/**
 * A harness for the start/stop shells: a fake host whose unit file and supervisor answers we control.
 * `lock` is the pidfile's contents and `alive` the pids the fake OS admits to - together they stand in for
 * a node running under some other supervisor.
 */
function startHarness(
  over: Partial<ServiceDeps> & { onDisk?: string; lock?: string; alive?: number[] } = {},
): {
  deps: Partial<ServiceDeps>;
  lines: string[];
  writes: Array<{ path: string; content: string }>;
  ran: string[][];
} {
  const lines: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const ran: string[][] = [];
  const alive = new Set(over.alive ?? []);
  let onDisk = over.onDisk;
  const deps: Partial<ServiceDeps> = {
    platform: "darwin",
    homeDir: "/Users/me",
    nodeBin: BASE.nodeBin,
    scriptPath: BASE.scriptPath,
    logDir: BASE.logDir,
    lockFile: LOCK,
    isAlive: (pid) => alive.has(pid),
    pathEnv: undefined,
    mkdirp: () => {},
    writeFile: (path, content) => {
      writes.push({ path, content });
      onDisk = content;
    },
    readFile: (path) => (path === LOCK ? over.lock : onDisk),
    removeFile: () => {},
    fileExists: () => onDisk !== undefined,
    run: (argv) => {
      ran.push(argv);
      return { code: 0, output: "" };
    },
    capture: () => ({ code: 0, stdout: '\t"PID" = 4821;\n' }),
    inFlightJobs: () => [],
    out: (l) => void lines.push(l),
    ...over,
  };
  return { deps, lines, writes, ran };
}

test("runNodeStart: a healthy node is a NO-OP - `start` must not restart what is already working", async () => {
  const current = renderLaunchdPlist(BASE);
  const h = startHarness({ onDisk: current });

  const outcome = await runNodeStart({ token: BASE.token }, h.deps);

  assert.deepEqual(outcome, { kind: "running", code: 0, already: true });
  assert.equal(h.writes.length, 0, "the unit is already what we would write");
  assert.equal(h.ran.length, 0, "and it is already up, so touching launchctl would be a restart in disguise");
  // It prints NOTHING: `start` hands off to the caller, which renders the full status block. Two lines of
  // "already running" was a worse answer to "is my node ok" than the report the operator would type next.
  assert.deepEqual(h.lines, []);
});

test("runNodeStart: SELF-HEALS a stale unit - this is what saves an upgraded node from crash-looping", async () => {
  // The unit an older client wrote: it invokes bare `start`, which the new `start` would treat as
  // "ensure running" -> exit 0 -> KeepAlive restarts it -> forever.
  const stale = renderLaunchdPlist(BASE).replace(
    "<string>--foreground</string>\n",
    "",
  );
  const h = startHarness({ onDisk: stale });

  const outcome = await runNodeStart({ token: BASE.token }, h.deps);

  assert.deepEqual(outcome, { kind: "running", code: 0, already: false });
  assert.equal(h.writes.length, 1, "the stale unit is rewritten");
  assert.match(h.writes[0]!.content, /--foreground/);
  assert.deepEqual(
    h.ran.map((c) => c[0]),
    ["launchctl", "launchctl"],
    "and reloaded, so the supervisor picks up the repaired unit",
  );
});

test("runNodeStart: a stopped node is started again from the unit already on disk", async () => {
  const h = startHarness({
    onDisk: renderLaunchdPlist(BASE),
    capture: () => ({ code: 0, stdout: '\t"LastExitStatus" = 0;\n' }), // loaded, no PID: not running
  });

  const outcome = await runNodeStart({ token: BASE.token }, h.deps);

  assert.deepEqual(outcome, { kind: "running", code: 0, already: false });
  assert.equal(h.writes.length, 0, "the unit is current - only the loader needs to run");
  assert.deepEqual(h.ran[1], ["launchctl", "load", "-w", `/Users/me/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`]);
});

test("runNodeStart: no token and no unit is a clear error, not a mystery", async () => {
  const h = startHarness();
  const outcome = await runNodeStart({}, h.deps);
  assert.deepEqual(outcome, { kind: "error", code: 2 });
  assert.match(h.lines.join("\n"), /No enrolment token/);
});

test("runNodeStart: no token but an EXISTING unit still starts - the unit carries its own token", async () => {
  const h = startHarness({ onDisk: renderLaunchdPlist(BASE), capture: () => ({ code: 1, stdout: "" }) });

  const outcome = await runNodeStart({}, h.deps);

  assert.deepEqual(outcome, { kind: "running", code: 0, already: false });
  assert.equal(h.writes.length, 0, "we cannot re-render without a token, so we must not try");
  assert.ok(h.ran.length > 0, "but we can still load what is there");
});

test("runNodeStart: a host that cannot daemonise says so, and asks to be run in the foreground", async () => {
  const windows = startHarness({ platform: "win32" });
  assert.deepEqual(await runNodeStart({ token: BASE.token }, windows.deps), {
    kind: "foreground",
    reason: "no supported supervisor on this platform (launchd / systemd)",
  });

  // A Linux container: systemd exists as a binary, but there is no user session to talk to.
  const container = startHarness({ platform: "linux", capture: () => ({ code: 1, stdout: "" }) });
  const outcome = await runNodeStart({ token: BASE.token }, container.deps);
  assert.equal(outcome.kind, "foreground");
  assert.equal(container.writes.length, 0, "do not 'install' a service that could never start");
});

test("runNodeStop: stops without uninstalling, so `dahrk start` brings it straight back", async () => {
  const h = startHarness({ onDisk: renderLaunchdPlist(BASE) });

  assert.equal(await runNodeStop({}, h.deps), 0);

  assert.deepEqual(h.ran, [
    ["launchctl", "unload", "-w", `/Users/me/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`],
  ]);
  assert.match(h.lines.join("\n"), /Node stopped/);
  assert.match(h.lines.join("\n"), /stays stopped across reboots until you run `dahrk start`/);
});

test("runNodeStop: nothing installed is not an error, and points at how you would actually stop it", async () => {
  const h = startHarness();
  assert.equal(await runNodeStop({}, h.deps), 0);
  assert.equal(h.ran.length, 0);
  assert.match(h.lines.join("\n"), /nothing to stop/);
  assert.match(h.lines.join("\n"), /Ctrl-C/, "the likely case: they are running one in a terminal");
});

test("foreignNodePid: only a LIVE holder that is not the service's own node counts as foreign", () => {
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);
  assert.equal(foreignNodePid("82324\n", 4821, alive([82324, 4821])), 82324, "another supervisor's node");
  assert.equal(foreignNodePid("4821\n", 4821, alive([4821])), undefined, "the service's own node, exiting");
  assert.equal(foreignNodePid("82324\n", 4821, alive([4821])), undefined, "a crashed node's stale pidfile");
  assert.equal(foreignNodePid(undefined, 4821, alive([])), undefined, "no pidfile at all: nothing running");
  assert.equal(foreignNodePid("82324\n", undefined, alive([82324])), 82324, "no service running, but a node is");
});

test("runNodeStop: a node under ANOTHER supervisor survives the stop, and stop must not claim success", async () => {
  // The real incident: a pm2-supervised node kept taking Jobs straight through a `dahrk stop` that said
  // "Node stopped." The service pid (4821, per the harness's launchctl answer) is not the one holding the
  // pidfile, so the holder is somebody else's - and stopping the unit does nothing to it.
  const h = startHarness({ onDisk: renderLaunchdPlist(BASE), lock: "82324\n", alive: [82324, 4821] });

  assert.equal(await runNodeStop({}, h.deps), STOP_FOREIGN_NODE, "a non-zero exit: the host is still running a node");

  const out = h.lines.join("\n");
  assert.match(out, /STILL RUNNING on this host \(pid 82324\)/);
  assert.match(out, /pm2/, "name the likely culprit, since we cannot stop it for them");
  assert.match(out, /still taking Jobs/, "the reason it matters: it is not an idle stray");
});

test("runNodeStop: the service's own node, mid-shutdown, is not mistaken for a foreign one", async () => {
  // `launchctl unload` returns before the process has gone, so the pidfile still names it. Warning here
  // would fire on every single healthy stop.
  const h = startHarness({ onDisk: renderLaunchdPlist(BASE), lock: "4821\n", alive: [4821] });

  assert.equal(await runNodeStop({}, h.deps), 0);
  assert.doesNotMatch(h.lines.join("\n"), /STILL RUNNING/);
});

// --- The supervisor's chatter is ours to relay, not to leak ------------------------------------

test("an ignoreFailure command's output is SWALLOWED: `Unload failed` is not news, it is how start works", async () => {
  // `installCommands` opens with an unconditional `launchctl unload` so a re-install picks up a rewritten
  // plist. On a job launchd does not have loaded, that prints `Unload failed: 5: Input/output error` and
  // exits non-zero. It is marked ignoreFailure - but the old `run` inherited stdio, so the message had
  // ALREADY reached the operator's terminal before anyone checked the exit code. On every start, and on
  // every restart. Capturing it is what lets `runCommands` decide that nobody needs to read it.
  const h = harness({
    run: (argv) =>
      argv[1] === "unload"
        ? { code: 1, output: "Unload failed: 5: Input/output error\nTry running `launchctl bootout` as root" }
        : { code: 0, output: "" },
  });
  const code = await runServiceInstall({ token: "t" }, h.deps);
  assert.equal(code, 0, "the failure is ignored, as it always was");
  assert.doesNotMatch(h.lines.join("\n"), /Unload failed/, "and now so is its output");
  assert.doesNotMatch(h.lines.join("\n"), /bootout/);
});

test("a REAL failure prints the command's output, which is the only thing worth reading at that point", async () => {
  const h = harness({
    run: (argv) =>
      argv[1] === "load" ? { code: 1, output: "Load failed: 5: Input/output error" } : { code: 0, output: "" },
  });
  const code = await runServiceInstall({ token: "t" }, h.deps);
  assert.equal(code, 1);
  const out = h.lines.join("\n");
  assert.match(out, /command failed \(1\)/);
  assert.match(out, /Load failed: 5: Input\/output error/);
});

// --- restart is one act, not stop-then-start ---------------------------------------------------

test("restart NEVER says the node will stay stopped - that is stop's line, and it is false here", async () => {
  const h = startHarness({ onDisk: renderLaunchdPlist(BASE) });
  const outcome = await runNodeRestart({ token: BASE.token }, h.deps);
  assert.equal(outcome.kind, "running");
  const out = h.lines.join("\n");
  assert.doesNotMatch(out, /stays stopped across reboots/);
  assert.doesNotMatch(out, /Node stopped/);
});

test("restart stops and then starts: the unit is unloaded and loaded again in that order", async () => {
  const h = startHarness({ onDisk: renderLaunchdPlist(BASE) });
  await runNodeRestart({ token: BASE.token }, h.deps);
  const verbs = h.ran.filter((c) => c[0] === "launchctl").map((c) => c[1]);
  assert.ok(verbs.includes("unload"), "it stops");
  assert.equal(verbs.at(-1), "load", "and the last thing it does is bring it back up");
});

test("restart on a node with a stage in flight REFUSES, and names what it would have killed", async () => {
  // A stage is minutes-to-hours of agent time and real money. Killing one silently, because the operator
  // typed `restart` to pick up a client upgrade, is not a thing a tool should do without asking.
  const h = startHarness({
    onDisk: renderLaunchdPlist(BASE),
    inFlightJobs: () => [
      { jobId: "j1", runId: "r_8fa2c1", kind: "stage", stageId: "implement", startedAt: Date.now() - 60_000, nodePid: 4821 },
    ],
  });
  const outcome = await runNodeRestart({ token: BASE.token }, h.deps);

  assert.deepEqual(outcome, { kind: "error", code: BUSY_NODE });
  assert.equal(h.ran.length, 0, "nothing was touched");
  const out = h.lines.join("\n");
  assert.match(out, /running 1 job/);
  assert.match(out, /r_8fa2c1/);
  assert.match(out, /--force/);
});

test("restart --force interrupts the stage anyway, but says so rather than doing it silently", async () => {
  const h = startHarness({
    onDisk: renderLaunchdPlist(BASE),
    inFlightJobs: () => [
      { jobId: "j1", runId: "r_8fa2c1", kind: "stage", stageId: "implement", startedAt: Date.now(), nodePid: 4821 },
    ],
  });
  const outcome = await runNodeRestart({ token: BASE.token, force: true }, h.deps);
  assert.equal(outcome.kind, "running");
  assert.match(h.lines.join("\n"), /Forcing restart with 1 job/);
});

test("a ledger entry owned by a DEAD process does not block a restart - it is a leftover, not work", async () => {
  const h = startHarness({
    onDisk: renderLaunchdPlist(BASE),
    // The live node is pid 4821 (the harness's launchctl probe says so). This entry is from a node that died.
    inFlightJobs: () => [
      { jobId: "j1", runId: "r_dead", kind: "stage", startedAt: Date.now(), nodePid: 999 },
    ],
  });
  const outcome = await runNodeRestart({ token: BASE.token }, h.deps);
  assert.equal(outcome.kind, "running", "boot reconciliation deals with it; it must not wedge restart shut");
});

// --- liveness: a foreground / pm2 node is a REAL node --------------------------------------------

test("liveNodePid: falls back to the pidfile, so a node the supervisor never started is still seen", () => {
  const h = harness({
    fileExists: () => false, // no unit at all
    lockFile: "/lock",
    readFile: (p) => (p === "/lock" ? "4821\n" : undefined),
    isAlive: (pid) => pid === 4821,
  });
  assert.equal(liveNodePid(h.deps as ServiceDeps), 4821);
});

test("liveNodePid: a STALE pidfile (the process is gone) is not read back as a live node", () => {
  const h = harness({
    fileExists: () => false,
    lockFile: "/lock",
    readFile: (p) => (p === "/lock" ? "4821\n" : undefined),
    isAlive: () => false,
  });
  assert.equal(liveNodePid(h.deps as ServiceDeps), undefined);
});
