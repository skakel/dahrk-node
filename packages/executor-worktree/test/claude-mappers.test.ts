/**
 * Claude trace-mapping tests. Recorded SDK messages (no live calls, no credentials) are
 * mapped to the normalised trace envelope; we assert every event type the mapper produces,
 * the CYPACK-1177 buffered-response rule, and that each emitted event validates against the
 * contract schema (@dahrk/contracts trace schema (#/$defs/event)).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TraceEvent } from "@dahrk/contracts";
import { consumeClaudeMessage, mapClaudeMessage, newBufferState } from "../src/claude-mappers.js";
import { makeEmit } from "../src/runtime-session.js";

const here = dirname(fileURLToPath(import.meta.url));
const traceSchema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve("@dahrk/contracts"))), "..", "schemas", "trace.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(traceSchema);
const validateEvent = ajv.compile({ $ref: "https://skakel.io/schemas/trace.schema.json#/$defs/event" });

const m = (x: unknown): SDKMessage => x as SDKMessage;
const FIXED_TS = "2026-06-21T00:00:00Z";

/** Fold a fixture message stream through the buffered-response machine, stamp the envelope. */
function drive(fixtures: SDKMessage[], suppressStageExit = false): TraceEvent[] {
  const events: TraceEvent[] = [];
  const emit = makeEmit("claude-code", (e) => events.push(e), () => FIXED_TS);
  const state = newBufferState();
  for (const msg of fixtures) {
    for (const e of consumeClaudeMessage(msg, state, suppressStageExit).events) emit(e);
  }
  return events;
}

test("a full Claude turn maps to the normalised envelope; the final text is the response", () => {
  const fixtures = [
    m({ type: "system", subtype: "init", session_id: "s1" }),
    m({ type: "assistant", session_id: "s1", message: { role: "assistant", content: [{ type: "thinking", thinking: "I will fetch the data." }] } }),
    m({ type: "assistant", session_id: "s1", message: { role: "assistant", content: [{ type: "text", text: "Fetching the data." }] } }),
    m({ type: "assistant", session_id: "s1", message: { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "get_big_data", input: { n: 1 } }] } }),
    m({ type: "user", session_id: "s1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "9000 chars", is_error: false }] } }),
    m({ type: "assistant", session_id: "s1", message: { role: "assistant", content: [{ type: "text", text: "It returned 9000 characters." }] } }),
    m({ type: "result", subtype: "success", result: "It returned 9000 characters.", session_id: "s1", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }, total_cost_usd: 0.01, duration_ms: 1200 }),
  ];

  const events = drive(fixtures);
  const types = events.map((e) => e.type);

  // thinking -> thought; tool_use -> action emitted immediately, then the buffered
  // "Fetching the data." flushes as a thought (action precedes the flushed thought, as in
  // cyrus); tool_result -> observation; the final assistant text -> response; result -> state.
  assert.deepEqual(types, ["thought", "action", "thought", "observation", "response", "state"]);

  const action = events[1] as Extract<TraceEvent, { type: "action" }>;
  assert.equal(action.tool, "get_big_data");
  assert.equal(action.toolUseId, "tool_1");

  const obs = events[3] as Extract<TraceEvent, { type: "observation" }>;
  assert.equal(obs.toolUseId, "tool_1");
  assert.equal(obs.isError, false);

  const response = events[4] as Extract<TraceEvent, { type: "response" }>;
  assert.equal(response.text, "It returned 9000 characters.");

  const state = events[5] as Extract<TraceEvent, { type: "state" }>;
  assert.equal(state.event, "stage-exit");
  assert.equal(state.status, "ok");
  assert.deepEqual(state.usage, { input: 10, output: 5, cacheRead: 2, cacheCreate: 1 });

  for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
});

test("CYPACK-1177: a turn that ends on a tool call never posts tool-input JSON as the response", () => {
  const fixtures = [
    m({ type: "assistant", session_id: "s2", message: { role: "assistant", content: [{ type: "text", text: "Calling the tool now." }] } }),
    m({ type: "assistant", session_id: "s2", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "do_thing", input: { big: "payload" } }] } }),
    m({ type: "result", subtype: "success", result: "{...tool input...}", session_id: "s2", usage: {}, total_cost_usd: 0, duration_ms: 1 }),
  ];

  const events = drive(fixtures);
  const types = events.map((e) => e.type);
  // The action posts, then the buffered "Calling the tool now." flushes as a thought; the
  // result emits ONLY the stage-exit state - no response (the buffered body was tool-input JSON).
  assert.deepEqual(types, ["action", "thought", "state"]);
  assert.ok(!events.some((e) => e.type === "response"), "no response on a tool-ended turn");
  for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
});

test("a failed result maps to a failed stage-exit plus an error, and validates", () => {
  const fixtures = [
    m({ type: "assistant", session_id: "s3", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }),
    m({ type: "result", subtype: "error_during_execution", session_id: "s3", usage: {}, total_cost_usd: 0, duration_ms: 1 }),
  ];
  const events = drive(fixtures);
  const state = events.find((e) => e.type === "state") as Extract<TraceEvent, { type: "state" }>;
  const error = events.find((e) => e.type === "error") as Extract<TraceEvent, { type: "error" }>;
  assert.equal(state.status, "fail");
  assert.equal(error.kind, "result_error");
  // No response is posted on a failed turn.
  assert.ok(!events.some((e) => e.type === "response"));
  for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
});

test("interactive turns suppress the per-turn stage-exit; the stage runner owns the final one", () => {
  const fixtures = [
    m({ type: "assistant", session_id: "s4", message: { role: "assistant", content: [{ type: "text", text: "Hello there." }] } }),
    m({ type: "result", subtype: "success", result: "Hello there.", session_id: "s4", usage: {}, total_cost_usd: 0, duration_ms: 1 }),
  ];
  const events = drive(fixtures, true);
  assert.deepEqual(events.map((e) => e.type), ["response"], "only the response; no per-turn stage-exit");
});

test("recognised control messages emit nothing; unknown message types are flagged unrecognised", () => {
  assert.equal(mapClaudeMessage(m({ type: "system", subtype: "init" })).recognised, true);
  assert.deepEqual(mapClaudeMessage(m({ type: "system", subtype: "init" })).events, []);
  assert.equal(mapClaudeMessage(m({ type: "some_future_message" })).recognised, false);
});
