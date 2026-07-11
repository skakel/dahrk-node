/**
 * The structured half of `dahrk logs`. The payoff being tested is `--run`: a node's log and the hub's
 * view of the same run can finally be talked about as one thing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { filterRecords, parseRecords, renderRecord, runLogs, type LogsDeps } from "../src/logs.ts";

const rec = (o: Record<string, unknown>): string => JSON.stringify(o);

const JSONL = [
  rec({ level: 20, time: "2026-07-11T10:00:00Z", msg: "cloning mirror", component: "git", runId: "run-1" }),
  rec({ level: 30, time: "2026-07-11T10:00:01Z", msg: "JOB_STARTED:build j-1", runId: "run-1", stageId: "build" }),
  rec({ level: 50, time: "2026-07-11T10:00:02Z", msg: "JOB_ERROR:build boom", runId: "run-1", stageId: "build", err: { stack: "Error: boom\n  at x" } }),
  rec({ level: 30, time: "2026-07-11T10:00:03Z", msg: "JOB_STARTED:test j-2", runId: "run-2", stageId: "test" }),
].join("\n");

function deps(out: string[], jsonl = JSONL): LogsDeps {
  return {
    files: { out: "/s/node.out.log", err: "/s/node.err.log" },
    jsonlFile: "/s/node.jsonl",
    fileExists: (p) => p === "/s/node.jsonl",
    readFile: () => jsonl,
    run: async () => 0,
    out: (l) => void out.push(l),
  };
}

test("--run narrows to one run, which is the whole point of the correlation ids", async () => {
  const out: string[] = [];
  await runLogs({ lines: 100, follow: false, run: "run-1" }, deps(out));
  const text = out.join("\n");
  assert.ok(text.includes("JOB_STARTED:build j-1"));
  assert.ok(text.includes("cloning mirror"), "git lines carry the runId too");
  assert.ok(!text.includes("run-2") && !text.includes("j-2"), "run-2 leaked into a run-1 query");
});

test("--level filters by severity and above", () => {
  const all = parseRecords(JSONL);
  assert.equal(filterRecords(all, { level: "error", lines: 100 }).length, 1);
  assert.equal(filterRecords(all, { level: "info", lines: 100 }).length, 3); // info + error, not the debug
  assert.equal(filterRecords(all, { lines: 100 }).length, 4);
});

test("a record with a stack renders the stack - it is the reason this mode exists", () => {
  const errRecord = parseRecords(JSONL)[2];
  assert.ok(errRecord);
  const lines = renderRecord(errRecord);
  assert.match(lines[0] ?? "", /ERROR \[run-1\/build\] JOB_ERROR:build boom/);
  assert.ok(lines.some((l) => l.includes("at x")), "the stack was dropped");
});

test("--json emits raw records for jq", async () => {
  const out: string[] = [];
  await runLogs({ lines: 100, follow: false, json: true, run: "run-2" }, deps(out));
  assert.equal(out.length, 1);
  assert.equal((JSON.parse(out[0] ?? "{}") as { stageId: string }).stageId, "test");
});

test("a bare `logs` still tails the plain transcript rather than the structured log", async () => {
  const out: string[] = [];
  const argv: string[][] = [];
  const d: LogsDeps = {
    ...deps(out),
    fileExists: () => true,
    run: async (a) => {
      argv.push(a);
      return 0;
    },
  };
  await runLogs({ lines: 200, follow: false }, d);
  assert.deepEqual(argv[0], ["tail", "-n", "200", "/s/node.out.log", "/s/node.err.log"]);
});

test("an empty result says so, and says what it was narrowed to", async () => {
  const out: string[] = [];
  await runLogs({ lines: 100, follow: false, run: "run-nope" }, deps(out));
  assert.match(out.join("\n"), /No records for run run-nope/);
});

test("parseRecords survives a torn final line", () => {
  assert.equal(parseRecords(`${JSONL}\n{"level":30,"msg":"tor`).length, 4);
});
