/**
 * The net under the node's best-effort `.catch()` seams. Two things must hold: a stray background
 * rejection must not kill the node, and whatever happened must leave a stack behind - the old
 * `main().catch` printed `err.message` and threw the stack away, which is why a node that died on boot
 * left nothing to read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNodeLogger } from "@dahrk/edge";
import { installProcessSafetyNet, makeCrashHandlers, writeCrashRecord, type CrashRecord } from "../src/process-safety.ts";

const record = (over: Partial<CrashRecord> = {}): CrashRecord => ({
  at: "2026-07-11T10:00:00.000Z",
  kind: "uncaughtException",
  name: "Error",
  message: "boom",
  stack: "Error: boom\n  at x",
  clientVersion: "0.1.8",
  nodeVersion: "v22.0.0",
  platform: "darwin",
  arch: "arm64",
  uptimeSec: 42,
  ...over,
});

test("a crash record lands on disk, sortable and readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-crash-"));
  const file = writeCrashRecord(dir, record());
  assert.ok(file, "no crash file written");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as CrashRecord;
  assert.equal(parsed.message, "boom");
  assert.equal(parsed.stack, "Error: boom\n  at x");
  // The filename must be shell-safe and sort chronologically: crashes are read oldest-first.
  assert.match(readdirSync(dir)[0] ?? "", /^2026-07-11T10-00-00-000Z\.json$/);
});

test("writeCrashRecord never throws, even into a path that cannot exist", () => {
  // Failing to record a crash must not cause a second crash.
  assert.doesNotThrow(() => writeCrashRecord("/dev/null/nope", record()));
  assert.equal(writeCrashRecord("/dev/null/nope", record()), undefined);
});

test("an unhandled rejection is recorded with its stack, and reaches the structured log", () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-crash-"));
  const logDir = mkdtempSync(join(tmpdir(), "dahrk-log-"));
  const logger = createNodeLogger({ level: "silent", fileLevel: "error", dir: logDir });

  const { onUnhandledRejection } = makeCrashHandlers({
    logger,
    crashDir: dir,
    clientVersion: "0.1.8",
    activeJobIds: () => ["j-1"],
  });

  // The policy is invoked directly rather than by rejecting a real promise: `node:test` claims the
  // `unhandledRejection` event itself and would fail the test before our handler could be observed.
  onUnhandledRejection(new Error("stray background rejection"));

  const crashes = readdirSync(dir);
  assert.equal(crashes.length, 1, "expected exactly one crash record");
  const parsed = JSON.parse(readFileSync(join(dir, crashes[0] as string), "utf8")) as CrashRecord;
  assert.equal(parsed.kind, "unhandledRejection");
  assert.equal(parsed.message, "stray background rejection");
  assert.ok(parsed.stack?.includes("Error: stray background rejection"), "the stack was dropped");
  assert.deepEqual(parsed.activeJobIds, ["j-1"], "the wedged job should be named");

  // And it reached the structured log, where `dahrk logs --level error` will find it.
  assert.match(readFileSync(join(logDir, "node.jsonl"), "utf8"), /NODE_CRASH:unhandledRejection/);
});

test("a rejection carrying something that is not an Error is still recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-crash-"));
  const { onUnhandledRejection } = makeCrashHandlers({
    logger: createNodeLogger({ level: "silent" }),
    crashDir: dir,
    clientVersion: "0.1.8",
  });
  // A rejection can carry anything at all - a string, undefined, a plain object.
  onUnhandledRejection("just a string");
  const parsed = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0] as string), "utf8")) as CrashRecord;
  assert.equal(parsed.message, "just a string");
  assert.equal(parsed.name, "string");
});

test("installProcessSafetyNet registers and cleanly removes both listeners", () => {
  // Deltas, not absolutes: the test runner has listeners of its own on both events.
  const before = {
    rejection: process.listenerCount("unhandledRejection"),
    exception: process.listenerCount("uncaughtException"),
  };
  const net = installProcessSafetyNet({ logger: createNodeLogger({ level: "silent" }), clientVersion: "0.1.8" });
  assert.equal(process.listenerCount("unhandledRejection"), before.rejection + 1);
  assert.equal(process.listenerCount("uncaughtException"), before.exception + 1);

  net.uninstall();
  // A leaked handler across suites would swallow the next test's failures.
  assert.equal(process.listenerCount("unhandledRejection"), before.rejection);
  assert.equal(process.listenerCount("uncaughtException"), before.exception);
});
