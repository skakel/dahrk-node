/**
 * `dahrk logs`. The argv builder is pure; `runLogs` is driven with fake IO. The rotation test is the one
 * that matters: it pins the inode, because renaming a file a supervisor holds open is how you end up with
 * an empty log and a full disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logsCommand, rotateIfLarge, runLogs, type LogsDeps } from "../src/logs.ts";

test("logsCommand: shows history from both files, and follows only when asked", () => {
  assert.deepEqual(logsCommand({ files: ["/l/out.log", "/l/err.log"], lines: 200, follow: false }), [
    "tail",
    "-n",
    "200",
    "/l/out.log",
    "/l/err.log",
  ]);
  const followed = logsCommand({ files: ["/l/out.log"], lines: 20, follow: true });
  assert.deepEqual(followed, ["tail", "-n", "20", "-f", "/l/out.log"]);
});

function deps(over: Partial<LogsDeps> = {}): LogsDeps & { lines: string[]; ran: string[][] } {
  const lines: string[] = [];
  const ran: string[][] = [];
  return {
    files: { out: "/l/node.out.log", err: "/l/node.err.log" },
    fileExists: () => true,
    run: async (argv) => {
      ran.push(argv);
      return 0;
    },
    out: (l) => void lines.push(l),
    lines,
    ran,
    ...over,
  };
}

test("runLogs: tails whichever files exist", async () => {
  const d = deps();
  assert.equal(await runLogs({ lines: 50, follow: true }, d), 0);
  assert.deepEqual(d.ran, [["tail", "-n", "50", "-f", "/l/node.out.log", "/l/node.err.log"]]);
});

test("runLogs: stderr-only is still shown (a node that only ever crashed has no stdout log)", async () => {
  const d = deps({ fileExists: (p) => p.endsWith("err.log") });
  await runLogs({ lines: 10, follow: false }, d);
  assert.deepEqual(d.ran, [["tail", "-n", "10", "/l/node.err.log"]]);
});

test("runLogs: no logs at all is explained, not spat out as a tail ENOENT", async () => {
  const d = deps({ fileExists: () => false });
  const code = await runLogs({ lines: 200, follow: true }, d);

  assert.equal(code, 0, "a node you have not started yet is not an error");
  assert.equal(d.ran.length, 0, "and there is nothing to tail, so do not spawn one");
  const out = d.lines.join("\n");
  assert.match(out, /No logs yet/);
  assert.match(out, /dahrk start/);
  assert.match(out, /--foreground/, "say why a foreground node has no log file, since that is the likely cause");
});

test("rotateIfLarge: keeps the SAME inode - a supervisor holds this fd open and would write to a ghost", () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-logs-"));
  try {
    const file = join(dir, "node.out.log");
    writeFileSync(file, "x".repeat(1000));
    const before = statSync(file).ino;

    rotateIfLarge(file, 100);

    assert.equal(statSync(file).ino, before, "renaming/unlinking would orphan launchd's open descriptor");
    assert.equal(statSync(file).size, 0, "truncated in place, so the next append lands at offset 0");
    assert.equal(readFileSync(`${file}.1`, "utf8").length, 1000, "the previous generation is kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotateIfLarge: leaves a small log alone, and never throws on a missing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-logs-"));
  try {
    const file = join(dir, "node.out.log");
    writeFileSync(file, "small");
    rotateIfLarge(file, 10_000);
    assert.equal(readFileSync(file, "utf8"), "small");
    // Housekeeping must never be able to stop a node booting.
    assert.doesNotThrow(() => rotateIfLarge(join(dir, "nope.log"), 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
