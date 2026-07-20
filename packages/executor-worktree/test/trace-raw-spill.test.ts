/**
 * End-to-end trace-production test for the real-adapter path: a recorded message stream is
 * folded through the buffered-response machine and written via the production TraceWriter,
 * exactly as the stage runner wires it (writeRaw -> rawRef -> append). Asserts large payloads
 * spill to blobs/, the runtime-native raw/ sidecar is written, and events cite both.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceMeta } from "@dahrk/contracts";
import type { SDKMessage as ClaudeMessage } from "@anthropic-ai/claude-agent-sdk";
import { createTraceWriter } from "../src/trace-writer.js";
import { consumeClaudeMessage, newBufferState } from "../src/claude-mappers.js";
import { makeEmit } from "../src/runtime-session.js";

const meta: TraceMeta = {
  tenantId: "t_default",
  runId: "run-raw-test",
  stageId: "build",
  jobId: "job-1",
  attempt: 1,
  runtime: "claude-code",
  configDigest: "sha256:abc",
  startedAt: "2026-06-21T00:00:00Z",
};

const m = (x: unknown): ClaudeMessage => x as ClaudeMessage;

test("adapter path: raw sidecar written, large output spilled, events cite rawRef and the blob", () => {
  const scratch = mkdtempSync(join(tmpdir(), "dahrk-raw-"));
  const writer = createTraceWriter(scratch, meta, { spillBytes: 64 });
  const emit = makeEmit("claude-code", (e) => writer.append(e), () => "2026-06-21T00:00:01Z");
  const state = newBufferState();

  const bigOutput = "Z".repeat(5_000);
  const fixtures = [
    m({ type: "assistant", session_id: "s1", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "big.txt" } }] } }),
    m({ type: "user", session_id: "s1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: bigOutput, is_error: false }] } }),
    m({ type: "assistant", session_id: "s1", message: { role: "assistant", content: [{ type: "text", text: "Read the file." }] } }),
    m({ type: "result", subtype: "success", result: "Read the file.", session_id: "s1", usage: {}, total_cost_usd: 0, duration_ms: 1 }),
  ];

  // Drive it exactly as the adapter does: persist the native record, then emit with its rawRef.
  for (const msg of fixtures) {
    const rawRef = writer.writeRaw(msg);
    for (const e of consumeClaudeMessage(msg, state, false).events) emit(e, rawRef);
  }
  writer.finalise({ status: "ok", endedAt: "2026-06-21T00:00:02Z" });

  const lines = readFileSync(join(writer.dir, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

  // Every emitted event cites a raw sidecar file that exists.
  for (const e of lines) {
    assert.ok(typeof e.rawRef === "string" && e.rawRef.startsWith("raw/"), `event has a raw sidecar ref: ${JSON.stringify(e)}`);
    assert.ok(existsSync(join(writer.dir, e.rawRef)), `raw sidecar file exists: ${e.rawRef}`);
  }

  // The four native messages were persisted under raw/ (0..3).
  for (let i = 0; i < 4; i++) assert.ok(existsSync(join(writer.dir, "raw", `${i}.json`)), `raw/${i}.json written`);
  const raw0 = JSON.parse(readFileSync(join(writer.dir, "raw", "0.json"), "utf8")) as { type: string };
  assert.equal(raw0.type, "assistant", "raw sidecar holds the runtime-native record");

  // The large tool output spilled to blobs/ and is carried intact (never truncated).
  const obs = lines.find((e) => e.type === "observation");
  assert.equal(obs.output, undefined, "large output removed from the JSONL line");
  assert.ok(typeof obs.outputRef === "string" && obs.outputRef.startsWith("blobs/"), "referenced by outputRef");
  assert.equal(readFileSync(join(writer.dir, obs.outputRef), "utf8"), bigOutput, "blob holds the full output");
});
