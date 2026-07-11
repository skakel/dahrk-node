/**
 * Two properties matter here and both are load-bearing elsewhere:
 *
 *  1. stdout stays byte-identical to the old `log()` output, because `ws-client.test.ts` asserts
 *     `line.startsWith("JOB_STARTED:")` and the harness greps these markers to time a kill.
 *  2. the file sink captures debug even when stdout is at info, because you never know you needed
 *     debug until after the incident.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNodeLogger } from "../src/logger.js";

/** Intercept stdout the same way ws-client.test.ts does, so we test the path the tests really use. */
function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return { lines, restore: () => void (process.stdout.write = orig) };
}

const readLog = (dir: string): Record<string, unknown>[] =>
  readFileSync(join(dir, "node.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test("stdout gets the bare marker line, with no level or timestamp prefix", () => {
  const cap = captureStdout();
  try {
    const log = createNodeLogger({ level: "info" });
    log.info({ stageId: "build", jobId: "j1" }, "JOB_STARTED:build j1");
    log.warn({}, "EDGE_STALE:16000ms without a pong, terminating socket");
    assert.deepEqual(cap.lines, ["JOB_STARTED:build j1\n", "EDGE_STALE:16000ms without a pong, terminating socket\n"]);
  } finally {
    cap.restore();
  }
});

test("the file sink captures debug while stdout stays at info", () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-log-"));
  const cap = captureStdout();
  try {
    const log = createNodeLogger({ level: "info", fileLevel: "debug", dir });
    log.debug({ component: "git" }, "cloning mirror");
    log.info({}, "EDGE_CONNECTED");

    // stdout saw only the info line...
    assert.deepEqual(cap.lines, ["EDGE_CONNECTED\n"]);
    // ...but the file has both, which is the whole point.
    const recs = readLog(dir);
    assert.deepEqual(
      recs.map((r) => r.msg),
      ["cloning mirror", "EDGE_CONNECTED"],
    );
    assert.equal(recs[0]?.component, "git");
  } finally {
    cap.restore();
  }
});

test("correlation ids and base bindings reach the file record", () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-log-"));
  const cap = captureStdout();
  try {
    const log = createNodeLogger({ level: "info", dir, base: { nodeId: "n-1" } });
    log.child({ runId: "run-1", stageId: "build", jobId: "j-1", attempt: 1 }).info({}, "JOB_STARTED:build j-1");
    const rec = readLog(dir)[0] ?? {};
    assert.equal(rec.nodeId, "n-1");
    assert.equal(rec.runId, "run-1");
    assert.equal(rec.stageId, "build");
    assert.equal(rec.jobId, "j-1");
    assert.equal(rec.attempt, 1);
  } finally {
    cap.restore();
  }
});

test("secrets are scrubbed on the way to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-log-"));
  const cap = captureStdout();
  const token = "ghp_abcdefghij0123456789abcdefghij0123";
  try {
    const log = createNodeLogger({ level: "info", dir });
    log.error(
      { err: new Error(`fatal: could not read Username for 'https://u:${token}@github.com'`) },
      "PUSH_ERROR:run-1 auth failed",
    );
    const raw = readFileSync(join(dir, "node.jsonl"), "utf8");
    assert.ok(!raw.includes(token), "the token reached the log file");
  } finally {
    cap.restore();
  }
});

test("rotation caps the file and keeps the tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-log-"));
  const cap = captureStdout();
  try {
    const log = createNodeLogger({ level: "silent", fileLevel: "info", dir, maxBytes: 2048, maxFiles: 2 });
    for (let i = 0; i < 200; i++) log.info({ i, pad: "x".repeat(100) }, `line ${i}`);
    // The live file is under the cap, and the most recent line is in it.
    const raw = readFileSync(join(dir, "node.jsonl"), "utf8");
    assert.ok(raw.length <= 2048 + 512, `live file not rotated: ${raw.length} bytes`);
    assert.ok(readFileSync(join(dir, "node.jsonl.1"), "utf8").length > 0, "expected a rotated file");
  } finally {
    cap.restore();
  }
});

test("a closed stdout (EPIPE) does not throw - a logger must never be the cause of a crash", () => {
  // Regression: `dahrk start | head` closes stdout once head has its lines. An unguarded write then
  // raises EPIPE -> uncaughtException -> the crash handler logs it through this same sink -> EPIPE
  // again. We shipped exactly that, and it produced crash records from nothing worse than a pipe.
  const dir = mkdtempSync(join(tmpdir(), "dahrk-log-"));
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => {
    const e = new Error("write EPIPE") as NodeJS.ErrnoException;
    e.code = "EPIPE";
    throw e;
  }) as typeof process.stdout.write;

  try {
    const log = createNodeLogger({ level: "info", dir });
    assert.doesNotThrow(() => log.info({}, "EDGE_CONNECTED"));
    // ...and the record still reached the file, which is the sink that actually matters afterwards.
    assert.match(readFileSync(join(dir, "node.jsonl"), "utf8"), /EDGE_CONNECTED/);
  } finally {
    process.stdout.write = orig;
  }
});

test("an unwritable log dir degrades to stdout instead of taking the node down", () => {
  const cap = captureStdout();
  try {
    // /dev/null/x can never be a directory; mkdir throws ENOTDIR.
    const log = createNodeLogger({ level: "info", dir: "/dev/null/nope" });
    log.info({}, "EDGE_CONNECTED");
    assert.deepEqual(cap.lines, ["EDGE_CONNECTED\n"]);
  } finally {
    cap.restore();
  }
});
