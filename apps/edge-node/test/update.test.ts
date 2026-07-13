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

/** Collect the printed lines and record whether an upgrade was spawned, so runUpdate is observable.
 *
 *  The default host has NO node running, which is the case where the restart question never comes up at
 *  all. The tests that care about it opt in with `nodeRunning: () => true`. */
const NOW = Date.parse("2026-07-13T12:00:00Z");

function harness(over: Partial<UpdateDeps>): {
  deps: Partial<UpdateDeps>;
  lines: string[];
  ran: string[][];
  counter: { restarts: number };
  saved: Array<{ updateCheckedAt: string; updateLatest: string }>;
} {
  const lines: string[] = [];
  const ran: string[][] = [];
  const counter = { restarts: 0 };
  const saved: Array<{ updateCheckedAt: string; updateLatest: string }> = [];
  const deps: Partial<UpdateDeps> = {
    binPath: "/usr/local/lib/node_modules/dahrk-node/dist/main.js", // npm channel by default
    out: (l) => lines.push(l),
    runUpgrade: (argv) => {
      ran.push(argv);
      return { code: 0, output: "npm warn ERESOLVE overriding peer dependency\nchanged 123 packages" };
    },
    saveResult: (patch) => void saved.push(patch),
    now: () => NOW,
    nodeRunning: () => false,
    interactive: () => false,
    confirm: async () => true,
    restart: async () => {
      counter.restarts++;
      return 0;
    },
    ...over,
  };
  // `counter` is returned as an object, not a number: destructuring a getter would snapshot it at zero
  // and every "did it restart?" assertion would silently pass.
  return { deps, lines, ran, counter, saved };
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
  assert.match(out, /Update available: 0\.1\.3 .* 0\.2\.0/);
  assert.match(out, /npm install -g dahrk-node@latest/);
});

test("runUpdate: an available update on the npm channel runs the upgrade and reports old->new", async () => {
  const { deps, lines, ran } = harness({ fetchLatest: async () => "0.2.0" });
  const code = await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(code, 0);
  assert.deepEqual(ran, [["npm", "install", "-g", "dahrk-node@latest"]]);
  const out = lines.join("\n");
  assert.match(out, /Update available: 0\.1\.3 .* 0\.2\.0/);
  assert.match(out, /Upgraded to 0\.2\.0/);
});

test("runUpdate: a SUCCESSFUL upgrade hides the package manager's wall of noise", async () => {
  // npm prints a screen of ERESOLVE peer-dependency warnings about our own transitive zod on every
  // successful global install. It is alarming, it is not actionable, and it is not a problem.
  const { deps, lines } = harness({ fetchLatest: async () => "0.2.0" });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.doesNotMatch(lines.join("\n"), /ERESOLVE/);
});

test("runUpdate --verbose: ...but shows it when asked", async () => {
  const { deps, lines } = harness({ fetchLatest: async () => "0.2.0" });
  await runUpdate({ currentVersion: "0.1.3", check: false, verbose: true }, deps);
  assert.match(lines.join("\n"), /ERESOLVE/);
});

test("runUpdate: a failing upgrade surfaces its exit code AND its output, verbose or not", async () => {
  const { deps, lines } = harness({
    fetchLatest: async () => "0.2.0",
    runUpgrade: () => ({ code: 7, output: "EACCES: permission denied" }),
  });
  const code = await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(code, 7);
  const out = lines.join("\n");
  assert.match(out, /Upgrade failed \(exit 7\)/);
  assert.match(out, /EACCES: permission denied/, "on failure the output is the whole point");
});

// --- The restart question: `dahrk start` never picked up an upgrade, and used to say it would ---

test("runUpdate: a running node is offered a restart, and `dahrk start` is NEVER the advice", async () => {
  const { deps, lines, counter } = harness({
    fetchLatest: async () => "0.2.0",
    nodeRunning: () => true,
    interactive: () => true,
    confirm: async () => true,
  });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  const out = lines.join("\n");
  assert.equal(counter.restarts, 1, "saying yes restarts the node");
  assert.match(out, /Node restarted on the new build/);
  // The old bug: it told you to run `dahrk start`, which no-ops on a running node and picks up nothing.
  assert.doesNotMatch(out, /`dahrk start`/);
});

test("runUpdate: declining the restart says how to do it later, and does not restart", async () => {
  const { deps, lines, counter } = harness({
    fetchLatest: async () => "0.2.0",
    nodeRunning: () => true,
    interactive: () => true,
    confirm: async () => false,
  });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(counter.restarts, 0);
  assert.match(lines.join("\n"), /Run `dahrk restart` when you are ready/);
});

test("runUpdate: a non-interactive caller is told to restart, never prompted", async () => {
  const { deps, lines, counter } = harness({
    fetchLatest: async () => "0.2.0",
    nodeRunning: () => true,
    interactive: () => false,
    confirm: async () => assert.fail("must not prompt when nobody is there to answer"),
  });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(counter.restarts, 0);
  assert.match(lines.join("\n"), /Run `dahrk restart` to pick this up/);
});

test("runUpdate: with NO node running there is nothing to restart, so nothing is said about it", async () => {
  const { deps, lines, counter } = harness({ fetchLatest: async () => "0.2.0", nodeRunning: () => false });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.equal(counter.restarts, 0);
  assert.doesNotMatch(lines.join("\n"), /restart/i, "advice about a problem nobody has is just noise");
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

// --- The cache: fetching the truth and then forgetting it is the bug -----------------------------

test("runUpdate: writes down what the registry said, so `dahrk status` is not left guessing", async () => {
  // `status` is offline by contract - it can only ever report what someone else has already learned. This
  // command used to fetch the true latest version, print it, and throw it away, so you could be told 0.2.0
  // exists and have `status` go on insisting it knew nothing about any update.
  const { deps, saved } = harness({ fetchLatest: async () => "0.2.0" });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.deepEqual(saved, [{ updateCheckedAt: new Date(NOW).toISOString(), updateLatest: "0.2.0" }]);
});

test("runUpdate --check: persists too - it is the ONLY way to refresh a stale cache by hand", async () => {
  // The daemon's periodic check is the only other writer, so on a machine whose node is not running this is
  // the sole command that can bring `status` up to date. A --check that reported the truth and forgot it
  // would leave the operator no way out of a stale answer at all.
  const { deps, saved, ran } = harness({ fetchLatest: async () => "0.2.0" });
  await runUpdate({ currentVersion: "0.1.3", check: true }, deps);
  assert.equal(ran.length, 0, "--check still changes nothing on disk except what we now know");
  assert.deepEqual(saved, [{ updateCheckedAt: new Date(NOW).toISOString(), updateLatest: "0.2.0" }]);
});

test("runUpdate: 'already current' is a fact worth recording, not just printing", async () => {
  // Otherwise the cache stays `unknown` forever on a machine that is perfectly up to date, and `status`
  // keeps saying "update status unknown" to someone who has just been told they are current.
  const { deps, saved } = harness({ fetchLatest: async () => "0.1.3" });
  await runUpdate({ currentVersion: "0.1.3", check: false }, deps);
  assert.deepEqual(saved, [{ updateCheckedAt: new Date(NOW).toISOString(), updateLatest: "0.1.3" }]);
});

test("runUpdate: a registry failure writes NOTHING - we must not record an answer we never got", async () => {
  const { deps, saved } = harness({
    fetchLatest: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  assert.equal(await runUpdate({ currentVersion: "0.1.3", check: false }, deps), 1);
  assert.deepEqual(saved, [], "a failed check must leave the previous answer, and its age, untouched");
});
