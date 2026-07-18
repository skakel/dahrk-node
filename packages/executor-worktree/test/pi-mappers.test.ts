/**
 * Pi trace-mapping tests ( Spike B). The acceptance check: a fixture Pi event stream
 * produces a TraceEvent sequence STRUCTURALLY IDENTICAL to the Claude mapper's output for
 * the same logical stage. We also assert the CYPACK-1177 buffered-response rule over Pi's streamed
 * deltas, and that every emitted event validates against the contract schema.
 *
 * No live calls, no credentials: the fixtures are hand-authored to the vendored Pi docs (sdk.md event
 * list, session-format.md `Usage`). Note that Pi streams deltas and settles at `turn_end`/`agent_end`;
 * we compare the normalised TYPE SEQUENCE plus the discriminating fields (the envelope is cross-runtime
 * uniform), not byte-equality of the source records.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TraceEvent } from "@dahrk/contracts";
import { consumePiEvent, mapPiEvent, newPiBufferState, type PiEvent } from "../src/pi-mappers.js";
import { consumeClaudeMessage, newBufferState } from "../src/claude-mappers.js";
import { makeEmit } from "../src/runner-shared.js";

const here = dirname(fileURLToPath(import.meta.url));
const traceSchema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve("@dahrk/contracts"))), "..", "schemas", "trace.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(traceSchema);
const validateEvent = ajv.compile({ $ref: "https://skakel.io/schemas/trace.schema.json#/$defs/event" });

const FIXED_TS = "2026-06-21T00:00:00Z";
const pe = (x: unknown): PiEvent => x as PiEvent;
const cm = (x: unknown): SDKMessage => x as SDKMessage;

/** Fold a Pi event stream through the buffered-response machine, stamp the envelope. */
function drivePi(fixtures: PiEvent[], suppressStageExit = false): TraceEvent[] {
  const events: TraceEvent[] = [];
  const emit = makeEmit("pi", (e) => events.push(e), () => FIXED_TS);
  const state = newPiBufferState();
  for (const ev of fixtures) {
    for (const e of consumePiEvent(ev, state, suppressStageExit).events) emit(e);
  }
  return events;
}

function driveClaude(fixtures: SDKMessage[]): TraceEvent[] {
  const events: TraceEvent[] = [];
  const emit = makeEmit("claude-code", (e) => events.push(e), () => FIXED_TS);
  const state = newBufferState();
  for (const msg of fixtures) {
    for (const e of consumeClaudeMessage(msg, state, false).events) emit(e);
  }
  return events;
}

test("ACCEPTANCE: a Pi event stream maps to the SAME envelope sequence as Claude", () => {
  // One logical stage: a reasoning step, one tool call + its result, then a final assistant response.
  // Encoded two ways; each mapper must yield thought -> action -> observation -> response -> state.
  const pi = drivePi([
    pe({ type: "agent_start" }),
    pe({ type: "turn_start" }),
    pe({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Plan: run the tests." } }),
    pe({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_1", args: { command: "pnpm test" } }),
    pe({ type: "tool_execution_end", toolCallId: "call_1", content: "3 passing", isError: false }),
    pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "All three tests pass." } }),
    pe({ type: "agent_end", messages: [{ stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 } }] }),
  ]);

  const claude = driveClaude([
    cm({ type: "system", subtype: "init", session_id: "s1" }),
    cm({ type: "assistant", session_id: "s1", message: { role: "assistant", content: [{ type: "thinking", thinking: "Plan: run the tests." }] } }),
    cm({ type: "assistant", session_id: "s1", message: { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "pnpm test" } }] } }),
    cm({ type: "user", session_id: "s1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "3 passing", is_error: false }] } }),
    cm({ type: "assistant", session_id: "s1", message: { role: "assistant", content: [{ type: "text", text: "All three tests pass." }] } }),
    cm({ type: "result", subtype: "success", result: "All three tests pass.", session_id: "s1", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }),
  ]);

  const expected = ["thought", "action", "observation", "response", "state"];
  assert.deepEqual(pi.map((e) => e.type), expected, "Pi type sequence");
  assert.deepEqual(claude.map((e) => e.type), expected, "Claude type sequence");

  // The discriminating fields line up across both envelopes.
  for (const events of [pi, claude]) {
    const thought = events[0] as Extract<TraceEvent, { type: "thought" }>;
    assert.equal(thought.subtype, "reasoning_text");
    assert.equal(thought.text, "Plan: run the tests.");

    const action = events[1] as Extract<TraceEvent, { type: "action" }>;
    assert.equal(action.toolUseId, "call_1");
    assert.deepEqual(action.input, { command: "pnpm test" });

    const obs = events[2] as Extract<TraceEvent, { type: "observation" }>;
    assert.equal(obs.output, "3 passing");
    assert.equal(obs.isError, false);

    const response = events[3] as Extract<TraceEvent, { type: "response" }>;
    assert.equal(response.text, "All three tests pass.");

    const state = events[4] as Extract<TraceEvent, { type: "state" }>;
    assert.equal(state.event, "stage-exit");
    assert.equal(state.status, "ok");

    for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
  }

  const piState = pi[4] as Extract<TraceEvent, { type: "state" }>;
  const claudeState = claude[4] as Extract<TraceEvent, { type: "state" }>;
  assert.deepEqual(piState.usage, { input: 10, output: 5, cacheRead: 2, cacheCreate: 1 });
  assert.deepEqual(piState.usage, claudeState.usage, "Pi normalises usage identically to Claude");
});

test("CYPACK-1177: the response is the last assistant text; a tool-ended turn posts no response", () => {
  // Turn 1 narrates then calls a tool (tool-ended); turn 2 streams the real answer.
  const events = drivePi([
    pe({ type: "turn_start" }),
    pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Calling the tool now." } }),
    pe({ type: "tool_execution_start", toolName: "bash", toolCallId: "t2", args: { command: "ls" } }),
    pe({ type: "tool_execution_end", toolCallId: "t2", content: "a.ts\nb.ts", isError: false }),
    pe({ type: "turn_end", message: { stopReason: "toolUse" } }),
    pe({ type: "turn_start" }),
    pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Two files: a.ts and b.ts." } }),
    pe({ type: "agent_end", messages: [{ stopReason: "stop", usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 } }] }),
  ]);

  // The intermediate "Calling the tool now." never becomes a response; the last text does.
  const responses = events.filter((e) => e.type === "response") as Extract<TraceEvent, { type: "response" }>[];
  assert.equal(responses.length, 1, "exactly one response");
  assert.equal(responses[0]?.text, "Two files: a.ts and b.ts.");

  // The first (tool-ended) turn_end settles with a stage-exit but no response.
  const firstSettle = events.findIndex((e) => e.type === "state");
  assert.ok(firstSettle >= 0);
  assert.ok(!events.slice(0, firstSettle).some((e) => e.type === "response"), "no response before the tool-ended settle");
  for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
});

test("a bare tool-ended prompt yields no response at all", () => {
  const events = drivePi([
    pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Running it." } }),
    pe({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: {} }),
    pe({ type: "tool_execution_end", toolCallId: "t1", content: "done" }),
    pe({ type: "agent_end", messages: [{ stopReason: "toolUse" }] }),
  ]);
  assert.deepEqual(events.map((e) => e.type), ["action", "observation", "state"]);
  assert.ok(!events.some((e) => e.type === "response"), "text before a tool call is not the response");
});

test("interactive turns suppress the per-turn stage-exit; a large tool output survives intact", () => {
  const suppressed = drivePi(
    [
      pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello there." } }),
      pe({ type: "turn_end", message: { stopReason: "stop" } }),
    ],
    true,
  );
  assert.deepEqual(suppressed.map((e) => e.type), ["response"], "only the response; no per-turn stage-exit");

  const big = "Y".repeat(12_000);
  const events = drivePi([
    pe({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1", args: { command: "cat big" } }),
    pe({ type: "tool_execution_end", toolCallId: "c1", content: big, isError: false }),
    pe({ type: "agent_end", messages: [{ stopReason: "stop" }] }),
  ]);
  const obs = events[1] as Extract<TraceEvent, { type: "observation" }>;
  assert.equal((obs.output as string).length, 12_000, "large output is carried intact (the writer spills it)");
  for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
});

test("a failed agent_end maps to an error plus a failed stage-exit; noise and unknowns are classified", () => {
  const events = drivePi([
    pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } }),
    pe({ type: "agent_end", messages: [{ stopReason: "error", errorMessage: "provider 500" }] }),
  ]);
  const state = events.find((e) => e.type === "state") as Extract<TraceEvent, { type: "state" }>;
  const error = events.find((e) => e.type === "error") as Extract<TraceEvent, { type: "error" }>;
  assert.equal(state.status, "fail");
  assert.equal(error.kind, "agent_error");
  assert.equal(error.message, "provider 500");
  assert.ok(!events.some((e) => e.type === "response"), "no response on a failed settle");
  for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);

  // Lifecycle noise is recognised with no events; an unknown event type is flagged unrecognised.
  assert.equal(mapPiEvent(pe({ type: "compaction_start" })).recognised, true);
  assert.deepEqual(mapPiEvent(pe({ type: "compaction_start" })).events, []);
  assert.equal(mapPiEvent(pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } })).recognised, true);
  assert.equal(mapPiEvent(pe({ type: "some_future_event" })).recognised, false);
});
