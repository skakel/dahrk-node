/**
 * Pi runtime adapter tests. The acceptance check: a Pi-runtime stage runs
 * batch + interactive + summarise to completion and the emitted trace matches the SAME
 * normalised envelope the Claude/Codex adapters produce (the fixture).
 *
 * The real `@earendil-works/pi-coding-agent` SDK makes live inference calls and is not
 * installed here, so we drive the adapter through its injected session factory with a
 * scripted fake `AgentSession` (a queue of per-prompt event scripts, matching Pi's
 * resume-per-turn model). This mirrors the repo's testing philosophy: the pure mapping is
 * proven in pi-mappers.test.ts; here we prove the adapter's orchestration wires those events
 * through to `onTrace`, settles batch/interactive/summarise, and cancels cleanly. No live
 * calls, no credentials.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { HumanTurn, RunnerContext, TraceEvent } from "@dahrk/contracts";
import type { PiEvent } from "../src/pi-mappers.js";
import { createPiRunner, type PiSessionLike, PI_STAGE_COMPLETE_TOOL } from "../src/pi-adapter.js";
import { makeRunner } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const traceSchema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve("@dahrk/contracts"))), "..", "schemas", "trace.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(traceSchema);
const validateEvent = ajv.compile({ $ref: "https://skakel.io/schemas/trace.schema.json#/$defs/event" });
const pe = (x: unknown): PiEvent => x as PiEvent;

/**
 * A scripted fake `AgentSession`. Each `prompt()` call shifts and replays the next event
 * script through every subscribed listener before resolving, modelling Pi's resume-per-turn
 * loop where one `prompt()` drives exactly one agent turn to completion.
 */
class FakePiSession implements PiSessionLike {
  sessionId = "pi-sess-1";
  agent = { state: { tools: ["read", "bash", "edit", "write"] as unknown[] } };
  prompts: string[] = [];
  aborted = false;
  disposed = false;
  private listeners: Array<(e: PiEvent) => void> = [];
  constructor(private readonly scripts: PiEvent[][]) {}
  subscribe(listener: (e: PiEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    const script = this.scripts.shift() ?? [];
    for (const ev of script) for (const l of [...this.listeners]) l(ev);
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
  dispose(): void {
    this.disposed = true;
  }
}

const ctx = (over: Partial<RunnerContext> = {}): RunnerContext => ({
  config: { runtime: "pi", interaction: "batch" } as RunnerContext["config"],
  workspace: { worktreePath: "/tmp/wt", branch: "main" } as RunnerContext["workspace"],
  issueContext: "Fix the failing tests.",
  ...over,
});

const turnsFrom = (texts: string[]): AsyncIterable<HumanTurn> => ({
  async *[Symbol.asyncIterator]() {
    for (const t of texts) yield { text: t, ts: "2026-06-21T00:00:00Z" };
  },
});

/** The logical stage: reasoning -> one tool call + result -> final response. */
const STAGE_SCRIPT: PiEvent[] = [
  pe({ type: "agent_start" }),
  pe({ type: "turn_start" }),
  pe({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Plan: run the tests." } }),
  pe({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_1", args: { command: "pnpm test" } }),
  pe({ type: "tool_execution_end", toolCallId: "call_1", content: "3 passing", isError: false }),
  pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "All three tests pass." } }),
  pe({ type: "agent_end", messages: [{ stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 } }] }),
];

test("makeRunner('pi') returns a Pi runner without importing the live SDK", () => {
  const runner = makeRunner("pi");
  assert.equal(runner.runtime, "pi");
});

test("ACCEPTANCE runBatch: the emitted trace matches the Claude/Codex envelope ( fixture)", async () => {
  const events: TraceEvent[] = [];
  const raw: unknown[] = [];
  const fake = new FakePiSession([STAGE_SCRIPT]);
  const runner = createPiRunner({ createSession: async () => fake });

  const result = await runner.runBatch(
    ctx({ writeRaw: (r) => (raw.push(r), `raw/${raw.length}.json`) }),
    (e) => events.push(e),
  );

  assert.deepEqual(events.map((e) => e.type), ["thought", "action", "observation", "response", "state"]);
  const state = events[4] as Extract<TraceEvent, { type: "state" }>;
  assert.equal(state.event, "stage-exit");
  assert.equal(state.status, "ok");
  assert.deepEqual(state.usage, { input: 10, output: 5, cacheRead: 2, cacheCreate: 1 });
  for (const e of events) {
    assert.equal(e.runtime, "pi");
    assert.ok(e.rawRef, "each event carries a rawRef from writeRaw");
    assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
  }
  assert.equal(raw.length, STAGE_SCRIPT.length, "every native event was persisted via writeRaw");
  assert.equal(result.status, "ok");
  assert.equal(result.sessionId, "pi-sess-1");
  assert.match(fake.prompts[0] ?? "", /Fix the failing tests\./, "resolveStagePrompt folds in the ticket brief");
});

test("runBatch: a runtime failure settles status fail with an error event", async () => {
  const events: TraceEvent[] = [];
  const fake = new FakePiSession([
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } }),
     pe({ type: "agent_end", messages: [{ stopReason: "error", errorMessage: "provider 500" }] })],
  ]);
  const result = await createPiRunner({ createSession: async () => fake }).runBatch(ctx(), (e) => events.push(e));
  assert.equal(result.status, "fail");
  const err = events.find((e) => e.type === "error") as Extract<TraceEvent, { type: "error" }>;
  assert.equal(err.kind, "agent_error");
  assert.equal(err.message, "provider 500");
});

test("runInteractive gate exit: opening turn is self-seeded; per-turn stage-exit suppressed; a summary turn produces the recap", async () => {
  const events: TraceEvent[] = [];
  const fake = new FakePiSession([
    // Self-seeded opening turn: the agent asks its first question before any human input.
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "What is the objective?" } }),
     pe({ type: "turn_end", message: { stopReason: "stop" } })],
    // Human turn 1
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Here is the answer." } }),
     pe({ type: "turn_end", message: { stopReason: "stop" } })],
    // Engine-owned summarise turn (turns exhausted -> gate)
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Explained the fix; tests pass." } }),
     pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
  ]);
  const runner = createPiRunner({ createSession: async () => fake });
  const result = await runner.runInteractive(ctx(), turnsFrom(["what is wrong?"]), (e) => events.push(e));

  assert.equal(result.status, "ok");
  assert.equal(result.summary, "Explained the fix; tests pass.");
  // The opening turn is self-seeded from the resolved prompt (ticket brief) before any human input,
  // and the human turn follows it.
  assert.match(fake.prompts[0] ?? "", /Fix the failing tests\./, "opening turn seeded from resolveStagePrompt");
  assert.equal(fake.prompts[1], "what is wrong?", "the human turn follows the seed");
  // The conversational turn emits a response but NOT a per-turn stage-exit (the stage runner owns it).
  assert.ok(events.some((e) => e.type === "response"));
  assert.ok(!events.some((e) => e.type === "state"), "no per-turn stage-exit on the interactive path");
});

test("runInteractive self-seed: opens with an agent turn even with zero human turns", async () => {
  const events: TraceEvent[] = [];
  const fake = new FakePiSession([
    // The self-seeded opening turn: the interview starts itself.
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "What are we building?" } }),
     pe({ type: "turn_end", message: { stopReason: "stop" } })],
    // Engine-owned summarise turn (no human turns -> turns exhausted -> gate).
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "No answers were given." } }),
     pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
  ]);
  const runner = createPiRunner({ createSession: async () => fake });
  // No human turns at all: this is the label-triggered case that previously idled to a timeout.
  const result = await runner.runInteractive(ctx(), turnsFrom([]), (e) => events.push(e));

  assert.match(fake.prompts[0] ?? "", /Fix the failing tests\./, "opening turn seeded from the ticket brief");
  assert.ok(
    events.some((e) => e.type === "response" && (e as Extract<TraceEvent, { type: "response" }>).text?.includes("What are we building?")),
    "an opening model turn is emitted before any human input",
  );
  assert.equal(result.status, "ok");
});

test("runInteractive tool exit: the injected stage-complete tool ends the stage and yields its summary", async () => {
  const events: TraceEvent[] = [];
  const fake = new FakePiSession([
    // Self-seeded opening turn, then the human turn drives the tool-exit.
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "What should I do?" } }),
     pe({ type: "turn_end", message: { stopReason: "stop" } })],
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working on it." } }),
     pe({ type: "tool_execution_start", toolName: PI_STAGE_COMPLETE_TOOL, toolCallId: "sc1", args: { summary: "Refactored the parser." } }),
     pe({ type: "tool_execution_end", toolCallId: "sc1", content: "Stage marked complete.", isError: false }),
     pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
  ]);
  const runner = createPiRunner({ createSession: async () => fake });
  const result = await runner.runInteractive(
    ctx({ config: { runtime: "pi", interaction: "interactive", exit: "tool" } as RunnerContext["config"] }),
    turnsFrom(["do the work"]),
    (e) => events.push(e),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.summary, "Refactored the parser.");
  // The control tool must not leak into the stage trace as an action/observation.
  assert.ok(!events.some((e) => e.type === "action" || e.type === "observation"),
    "stage-complete tool call is control-plane, not stage work");
});

test("summarise: reuses the warm session, denies tools, returns the handoff sentence, emits no trace", async () => {
  const traceDuringBatch: TraceEvent[] = [];
  const fake = new FakePiSession([
    STAGE_SCRIPT,
    // The summarise turn.
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Ran the suite; all three tests pass." } }),
     pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
  ]);
  const runner = createPiRunner({ createSession: async () => fake });
  await runner.runBatch(ctx(), (e) => traceDuringBatch.push(e));
  const batchCount = traceDuringBatch.length;

  const summary = await runner.summarise(ctx());
  assert.equal(summary, "Ran the suite; all three tests pass.");
  assert.deepEqual(fake.agent.state.tools, [], "tools denied for the handoff turn");
  assert.equal(traceDuringBatch.length, batchCount, "summarise emits no trace events");
  assert.equal(fake.prompts.length, 2, "summarise reused the warm session (no new session created)");
});

test("cancel: aborts then disposes the session and suppresses a late error", async () => {
  const fake = new FakePiSession([STAGE_SCRIPT]);
  const runner = createPiRunner({ createSession: async () => fake });
  await runner.runBatch(ctx(), () => {});
  await runner.cancel();
  assert.equal(fake.aborted, true);
  assert.equal(fake.disposed, true);
  await runner.cancel(); // idempotent
});

test("runBatch: a prompt() exception (not a Pi SDK error event) emits runtime_error and settles fail", async () => {
  const events: TraceEvent[] = [];
  const throwingSession: PiSessionLike = {
    sessionId: "pi-throw",
    subscribe: (l) => {
      // Fire a partial event before the throw so we confirm it was received.
      l(pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } }));
      return () => {};
    },
    prompt: async () => { throw new Error("network timeout"); },
    abort: async () => {},
    dispose: () => {},
  };
  const result = await createPiRunner({ createSession: async () => throwingSession }).runBatch(ctx(), (e) => events.push(e));
  assert.equal(result.status, "fail");
  const err = events.find((e) => e.type === "error") as Extract<TraceEvent, { type: "error" }>;
  assert.equal(err.kind, "runtime_error");
  assert.equal(err.message, "network timeout");
});

test("summarise: returns the no-session placeholder when the session was never opened", async () => {
  const runner = createPiRunner({ createSession: async () => { throw new Error("should not be called"); } });
  const result = await runner.summarise(ctx());
  assert.equal(result, "(no summary: session not established)");
});

test("summarise: returns the unavailable message when prompt() throws during the handoff turn", async () => {
  const fake = new FakePiSession([STAGE_SCRIPT]);
  const runner = createPiRunner({ createSession: async () => fake });
  await runner.runBatch(ctx(), () => {});
  // Patch the session so the summarise prompt() throws.
  fake.prompt = async () => { throw new Error("model unavailable"); };
  const result = await runner.summarise(ctx());
  assert.match(result, /summary unavailable.*model unavailable/);
});
