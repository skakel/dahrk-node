import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCli, usage } from "../src/cli.ts";

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
    assert.deepEqual(p.flags, { token: "t", name: "my-mac", hubUrl: "ws://h:1", ephemeral: true });
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
});
