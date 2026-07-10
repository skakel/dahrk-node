import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectManager,
  renderLaunchdPlist,
  renderSystemdUnit,
  buildPlan,
  runServiceInstall,
  runServiceUninstall,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  type PlanInputs,
  type ServiceDeps,
} from "../src/service.ts";

const BASE: PlanInputs = {
  manager: "launchd",
  nodeBin: "/usr/local/bin/node",
  scriptPath: "/usr/local/lib/node_modules/dahrk-node/dist/main.js",
  token: "sket_abc",
  homeDir: "/Users/me",
  logDir: "/Users/me/.dahrk/logs",
};

test("detectManager: darwin->launchd, linux->systemd, else unsupported", () => {
  assert.equal(detectManager("darwin"), "launchd");
  assert.equal(detectManager("linux"), "systemd");
  assert.equal(detectManager("win32"), "unsupported");
});

test("renderLaunchdPlist: runs node+script start, token in the env block (not argv), keep-alive + logs", () => {
  const plist = renderLaunchdPlist(BASE);
  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  // ProgramArguments is node + the resolved script + `start` - the token is NOT an argument.
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>start<\/string>/);
  assert.doesNotMatch(plist, /<string>sket_abc<\/string>\s*<\/array>/);
  // Token rides in EnvironmentVariables instead.
  assert.match(plist, /<key>DAHRK_ENROL_TOKEN<\/key>\s*<string>sket_abc<\/string>/);
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

test("renderSystemdUnit: on-failure restart, 78 pinned as stop, token via Environment, network ordering", () => {
  const unit = renderSystemdUnit({ ...BASE, manager: "systemd" });
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/node \/usr\/local\/lib\/node_modules\/dahrk-node\/dist\/main\.js start/);
  assert.match(unit, /Environment=DAHRK_ENROL_TOKEN=sket_abc/);
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
  assert.match(plan.logHint, /journalctl --user/);
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
      return 0;
    },
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
  assert.match(writes[0]!.content, /DAHRK_ENROL_TOKEN<\/key>\s*<string>sket_abc/);
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
  const { deps } = harness({ run: () => 3, platform: "linux" });
  const code = await runServiceInstall({ token: "t" }, deps);
  assert.equal(code, 3);
});

test("install (systemd): the best-effort linger failure does not fail the install", async () => {
  // loginctl is the only failing command; because it is ignoreFailure, install still succeeds.
  const { deps } = harness({
    platform: "linux",
    run: (argv) => (argv[0] === "loginctl" ? 1 : 0),
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
