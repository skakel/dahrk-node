import { test } from "node:test";
import assert from "node:assert/strict";
import { isStructuredLogs, parseCli, usage } from "../src/cli.ts";

test("bare flags default to `start` (back-compat with the flag-first invocation)", () => {
  const p = parseCli(["--token", "sket_abc"]);
  assert.equal(p.kind, "start");
  if (p.kind === "start") {
    assert.equal(p.flags.token, "sket_abc");
    assert.equal(p.flags.ephemeral, false);
  }
});

test("`start` subcommand parses token/name/hub-url/ephemeral", () => {
  const p = parseCli(["start", "--token", "t", "--name", "my-mac", "--hub-url", "ws://h:1", "--ephemeral"]);
  assert.equal(p.kind, "start");
  if (p.kind === "start") {
    assert.deepEqual(p.flags, {
      token: "t",
      name: "my-mac",
      hubUrl: "ws://h:1",
      ephemeral: true,
      // An ephemeral node persists no id, so there is nothing coherent for a supervisor to restart on
      // boot: it is a foreground node whether or not you said so.
      foreground: true,
    });
  }
});

test("`doctor` subcommand parses connection flags", () => {
  const p = parseCli(["doctor", "--hub-url", "ws://h:1", "--token", "t"]);
  assert.equal(p.kind, "doctor");
  if (p.kind === "doctor") {
    assert.equal(p.flags.hubUrl, "ws://h:1");
    assert.equal(p.flags.token, "t");
  }
});

test("`run` parses the workflow positional plus repo/hub/token flags", () => {
  const p = parseCli(["run", "preflight", "--repo", "/w/app", "--hub-url", "ws://h:1", "--token", "t"]);
  assert.equal(p.kind, "run");
  if (p.kind === "run") {
    assert.deepEqual(p.flags, { workflow: "preflight", repo: "/w/app", hubUrl: "ws://h:1", token: "t" });
  }
});

test("`run` needs a workflow: bare `run` is an error", () => {
  const p = parseCli(["run"]);
  assert.equal(p.kind, "error");
  assert.equal(p.kind === "error" && /missing workflow/.test(p.message), true);
});

test("`run` takes one workflow at a time: a second positional is an error", () => {
  const p = parseCli(["run", "preflight", "extra"]);
  assert.equal(p.kind, "error");
  assert.equal(p.kind === "error" && /unexpected argument "extra"/.test(p.message), true);
});

test("`run` keeps an unknown workflow name (the dispatcher, not the parser, rejects it)", () => {
  const p = parseCli(["run", "frobnicate"]);
  assert.equal(p.kind, "run");
  assert.equal(p.kind === "run" && p.flags.workflow, "frobnicate");
});

test("a `run` subcommand's --help scopes to `run`", () => {
  assert.deepEqual(parseCli(["run", "--help"]), { kind: "help", command: "run" });
  assert.deepEqual(parseCli(["help", "run"]), { kind: "help", command: "run" });
});

test("`service` parses the action positional plus connection flags", () => {
  const p = parseCli(["service", "install", "--token", "t", "--name", "my-mac", "--hub-url", "ws://h:1"]);
  assert.equal(p.kind, "service");
  if (p.kind === "service") {
    assert.deepEqual(p.flags, { action: "install", token: "t", name: "my-mac", hubUrl: "ws://h:1" });
  }
  const u = parseCli(["service", "uninstall"]);
  assert.equal(u.kind, "service");
  assert.equal(u.kind === "service" && u.flags.action, "uninstall");
});

test("`service` needs an action: bare `service` is an error", () => {
  const p = parseCli(["service"]);
  assert.equal(p.kind, "error");
  assert.equal(p.kind === "error" && /missing action/.test(p.message), true);
});

test("`service` rejects an unknown action", () => {
  const p = parseCli(["service", "frobnicate"]);
  assert.equal(p.kind, "error");
  assert.equal(p.kind === "error" && /unknown action "frobnicate"/.test(p.message), true);
});

test("a `service` subcommand's --help scopes to `service`", () => {
  assert.deepEqual(parseCli(["service", "--help"]), { kind: "help", command: "service" });
  assert.deepEqual(parseCli(["help", "service"]), { kind: "help", command: "service" });
});

test("`update` parses `--check`; bare `update` defaults check off", () => {
  assert.deepEqual(parseCli(["update"]), { kind: "update", flags: { check: false, verbose: false } });
  assert.deepEqual(parseCli(["update", "--check"]), { kind: "update", flags: { check: true, verbose: false } });
});

test("`update` takes no positionals and rejects unknown flags", () => {
  assert.equal(parseCli(["update", "now"]).kind, "error");
  assert.equal(parseCli(["update", "--token", "t"]).kind, "error");
});

test("an `update` subcommand's --help scopes to `update`", () => {
  assert.deepEqual(parseCli(["update", "--help"]), { kind: "help", command: "update" });
  assert.deepEqual(parseCli(["help", "update"]), { kind: "help", command: "update" });
});

test("help spellings: `help`, `--help`, and scoped `help <command>`", () => {
  assert.deepEqual(parseCli(["help"]), { kind: "help" });
  assert.deepEqual(parseCli(["--help"]), { kind: "help" });
  assert.deepEqual(parseCli(["-h"]), { kind: "help" });
  assert.deepEqual(parseCli(["help", "start"]), { kind: "help", command: "start" });
  assert.deepEqual(parseCli(["help", "doctor"]), { kind: "help", command: "doctor" });
});

test("a subcommand's --help scopes to that command", () => {
  assert.deepEqual(parseCli(["doctor", "--help"]), { kind: "help", command: "doctor" });
  assert.deepEqual(parseCli(["start", "--help"]), { kind: "help", command: "start" });
});

test("version spellings", () => {
  assert.deepEqual(parseCli(["version"]), { kind: "version" });
  assert.deepEqual(parseCli(["--version"]), { kind: "version" });
  assert.deepEqual(parseCli(["-v"]), { kind: "version" });
});

test("an unknown command is an error, not a silent default-to-start", () => {
  const p = parseCli(["frobnicate"]);
  assert.equal(p.kind, "error");
  assert.equal(p.kind === "error" && /unknown command: frobnicate/.test(p.message), true);
});

test("an unknown flag is a parse error", () => {
  const p = parseCli(["start", "--nope"]);
  assert.equal(p.kind, "error");
});

test("usage text names the bin and the commands", () => {
  const top = usage("dahrk-node");
  assert.match(top, /dahrk-node <command>/);
  assert.match(top, /start/);
  assert.match(top, /doctor/);
  assert.match(usage("dahrk-node", "start"), /--ephemeral/);
  assert.match(usage("dahrk-node", "doctor"), /token validity/);
  assert.match(top, /run/);
  assert.match(usage("dahrk-node", "run"), /<workflow>/);
  assert.match(usage("dahrk-node", "run"), /preflight/);
  assert.match(top, /update/);
  assert.match(usage("dahrk-node", "update"), /--check/);
  assert.match(top, /service/);
  assert.match(usage("dahrk-node", "service"), /install\|uninstall/);
  assert.match(usage("dahrk-node", "service"), /launchd/);
});

// --- The daemon verbs. `stop` used to be `unknown command: stop`, which is where this all started.

test("stop / restart / logs are real commands now", () => {
  assert.equal(parseCli(["stop"]).kind, "stop");
  assert.equal(parseCli(["restart"]).kind, "restart");
  assert.equal(parseCli(["logs"]).kind, "logs");
});

test("--foreground opts out of the daemon and is the flag the installed unit passes", () => {
  const p = parseCli(["start", "--foreground"]);
  assert.equal(p.kind, "start");
  if (p.kind === "start") {
    assert.equal(p.flags.foreground, true);
    assert.equal(p.flags.ephemeral, false);
  }
  const plain = parseCli(["start"]);
  if (plain.kind === "start") assert.equal(plain.flags.foreground, false, "the default is now the daemon");
});

test("--ephemeral implies --foreground: a node with no persistent id has nothing to daemonise", () => {
  const p = parseCli(["start", "--ephemeral"]);
  if (p.kind === "start") assert.equal(p.flags.foreground, true);
});

test("logs: -f follows, -n sets the history, and a nonsense -n is a usage error not a NaN", () => {
  const followed = parseCli(["logs", "-f"]);
  assert.equal(followed.kind, "logs");
  if (followed.kind === "logs") assert.deepEqual(followed.flags, { lines: 200, follow: true, json: false });

  const counted = parseCli(["logs", "-n", "50"]);
  if (counted.kind === "logs") assert.deepEqual(counted.flags, { lines: 50, follow: false, json: false });

  const bad = parseCli(["logs", "-n", "lots"]);
  assert.equal(bad.kind, "error");
  if (bad.kind === "error") assert.match(bad.message, /--lines must be a non-negative whole number/);
});

test("logs: --run / --level / --json select the structured log, and a bad level is a usage error", () => {
  // These three flags are what switch `logs` from tailing the plain transcript to reading node.jsonl -
  // the only log that has levels, correlation ids and stacks to filter on in the first place.
  const byRun = parseCli(["logs", "--run", "run-7"]);
  assert.equal(byRun.kind, "logs");
  if (byRun.kind === "logs") {
    assert.equal(byRun.flags.run, "run-7");
    assert.ok(isStructuredLogs(byRun.flags));
  }

  const plain = parseCli(["logs"]);
  if (plain.kind === "logs") assert.ok(!isStructuredLogs(plain.flags), "a bare `logs` still tails the transcript");

  const bad = parseCli(["logs", "--level", "shouty"]);
  assert.equal(bad.kind, "error");
  if (bad.kind === "error") assert.match(bad.message, /--level must be one of/);
});

test("diagnose parses, and has no upload flag", () => {
  const d = parseCli(["diagnose", "--out", "/tmp/b.json"]);
  assert.equal(d.kind, "diagnose");
  if (d.kind === "diagnose") assert.equal(d.flags.out, "/tmp/b.json");

  // The absence of an upload path is a design commitment, not an omission: the bundle is written locally
  // so the operator can read it and decide. Lock it, so nobody "helpfully" adds one later.
  assert.equal(parseCli(["diagnose", "--upload"]).kind, "error");
  assert.doesNotMatch(usage("dahrk", "diagnose"), /--upload/);
});

test("help names the daemon verbs, and says how to opt out of the daemon", () => {
  const top = usage("dahrk");
  for (const cmd of ["start", "stop", "restart", "logs", "status"]) {
    assert.match(top, new RegExp(`^\\s+${cmd}\\s+\\S`, "m"), `\`${cmd}\` must be discoverable`);
  }
  assert.match(top, /--foreground/, "opting out must not be folklore");

  // The one place someone will look when they do not want a launch agent on their machine.
  const start = usage("dahrk", "start");
  assert.match(start, /--foreground/);
  assert.match(start, /DAHRK_FOREGROUND=1/);
});
