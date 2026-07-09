import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectChannel,
  isNewer,
  upgradeCommand,
  runUpdate,
  type UpdateDeps,
} from "../src/update.ts";

test("isNewer: strictly-newer core wins; equal and older do not; garbage never claims an update", () => {
  assert.equal(isNewer("0.2.0", "0.1.3"), true);
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.1.4", "0.1.3"), true);
  assert.equal(isNewer("0.1.3", "0.1.3"), false);
  assert.equal(isNewer("0.1.2", "0.1.3"), false);
  // A `v` prefix and a prerelease/build tail are tolerated (compared by core).
  assert.equal(isNewer("v0.2.0", "0.1.3"), true);
  assert.equal(isNewer("0.2.0-rc.1", "0.1.3"), true);
  // Unparseable either side => false (never claim an unverifiable update).
  assert.equal(isNewer("not-a-version", "0.1.3"), false);
  assert.equal(isNewer("0.2.0", "unknown"), false);
});

test("detectChannel: npm path, Homebrew Cellar path, and everything else unknown", () => {
  assert.equal(detectChannel("/usr/local/lib/node_modules/dahrk-node/dist/main.js"), "npm");
  assert.equal(detectChannel("/opt/homebrew/lib/node_modules/dahrk-node/dist/main.js"), "npm");
  assert.equal(detectChannel("/opt/homebrew/Cellar/dahrk/0.1.3/libexec/bin/dahrk"), "homebrew");
  assert.equal(detectChannel("/usr/local/Cellar/dahrk/0.1.3/libexec/bin/dahrk"), "homebrew");
  assert.equal(detectChannel("/Users/me/src/dahrk-node/apps/edge-node/dist/main.js"), "unknown");
  assert.equal(detectChannel(undefined), "unknown");
});

test("upgradeCommand: npm/homebrew have a command, unknown has none", () => {
  assert.deepEqual(upgradeCommand("npm")?.argv, ["npm", "install", "-g", "dahrk-node@latest"]);
  assert.deepEqual(upgradeCommand("homebrew")?.argv, ["brew", "upgrade", "dahrkai/tap/dahrk"]);
  assert.equal(upgradeCommand("unknown"), null);
});

/** Collect the printed lines and record whether an upgrade was spawned, so runUpdate is observable. */
function harness(over: Partial<UpdateDeps>): { deps: Partial<UpdateDeps>; lines: string[]; ran: string[][] } {
  const lines: string[] = [];
  const ran: string[][] = [];
  const deps: Partial<UpdateDeps> = {
    binPath: "/usr/local/lib/node_modules/dahrk-node/dist/main.js", // npm channel by default
    out: (l) => lines.push(l),
    runUpgrade: (argv) => {
      ran.push(argv);
      return 0;
    },
    ...over,
  };
  return { deps, lines, ran };
}

test("runUpdate: already current is a no-op, exit 0, and runs nothing", async () => {
  const { deps, lines, ran } = harness({ fetchLatest: async () => "0.1.3" });
  const code = await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(code, 0);
  assert.equal(ran.length, 0);
  assert.match(lines.join("\n"), /Already on the latest version \(0\.1\.3\)/);
});

test("runUpdate --check: reports current -> latest and how to apply, but runs nothing", async () => {
  const { deps, lines, ran } = harness({ fetchLatest: async () => "0.2.0" });
  const code = await runUpdate({ currentVersion: "0.1.3", check: true }, deps);
  assert.equal(code, 0);
  assert.equal(ran.length, 0);
  const out = lines.join("\n");
  assert.match(out, /Update available: 0\.1\.3 -> 0\.2\.0/);
  assert.match(out, /npm install -g dahrk-node@latest/);
});

test("runUpdate: an available update on the npm channel runs the upgrade and reports old->new", async () => {
  const { deps, lines, ran } = harness({ fetchLatest: async () => "0.2.0" });
  const code = await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(code, 0);
  assert.deepEqual(ran, [["npm", "install", "-g", "dahrk-node@latest"]]);
  const out = lines.join("\n");
  assert.match(out, /Update available: 0\.1\.3 -> 0\.2\.0/);
  assert.match(out, /Upgraded to 0\.2\.0/);
});

test("runUpdate: a failing upgrade command surfaces its exit code", async () => {
  const { deps, lines } = harness({ fetchLatest: async () => "0.2.0", runUpgrade: () => 7 });
  const code = await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(code, 7);
  assert.match(lines.join("\n"), /exited with code 7/);
});

test("runUpdate: an unknown channel prints the per-channel commands instead of running", async () => {
  const { deps, lines, ran } = harness({
    binPath: "/Users/me/src/dahrk-node/dist/main.js",
    fetchLatest: async () => "0.2.0",
  });
  const code = await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(code, 0);
  assert.equal(ran.length, 0);
  const out = lines.join("\n");
  assert.match(out, /Could not tell how this client was installed/);
  assert.match(out, /npm install -g dahrk-node@latest/);
  assert.match(out, /brew upgrade dahrkai\/tap\/dahrk/);
  assert.match(out, /install\.sh/);
});

test("runUpdate: a registry failure reports it and exits 1 without running", async () => {
  const { deps, lines, ran } = harness({
    fetchLatest: async () => {
      throw new Error("registry responded 503");
    },
  });
  const code = await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(code, 1);
  assert.equal(ran.length, 0);
  assert.match(lines.join("\n"), /Could not determine the latest version: registry responded 503/);
});
