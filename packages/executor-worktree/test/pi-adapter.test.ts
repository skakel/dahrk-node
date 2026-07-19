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
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { ElicitQuestion, HumanTurn, PolicyOutcome, RunnerContext, TraceEvent } from "@dahrk/contracts";
import type { PiEvent } from "../src/pi-mappers.js";
import {
  createPiRunner,
  piToolCallDecision,
  type AskUserQuestions,
  type PiSessionLike,
  type PolicyAwareRunnerContext,
  PI_STAGE_COMPLETE_TOOL,
} from "../src/pi-adapter.js";
import { makeRunner } from "../src/index.js";
import { ManagedMailbox } from "../src/runner-shared.js";

const traceSchema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve("@dahrk/contracts"))), "..", "schemas", "trace.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(traceSchema);
const validateEvent = ajv.compile({ $ref: "https://skakel.io/schemas/trace.schema.json#/$defs/event" });
const pe = (x: unknown): PiEvent => x as PiEvent;

/**
 * A per-prompt script step: either a fixed list of native events to replay, or a thunk the fake
 * awaits to produce them. The thunk models a turn in which the model calls the injected
 * `ask_user_question` tool (invoking the adapter's registered handler and parking until the human
 * replies) before emitting its follow-up events - the async shape Pi's live tool `execute` has.
 */
type ScriptStep = PiEvent[] | (() => PiEvent[] | Promise<PiEvent[]>);

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
  /** The dispatcher the adapter registers; a thunk step drives it to model the tool's execute. */
  askHandler?: (questions: AskUserQuestions) => Promise<string>;
  /** The pre-execution gate the adapter registers (DHK-504); consulted before each tool executes. */
  gate?: (toolName: string, input: unknown) => { block?: boolean; reason?: string } | undefined;
  /** Tool calls the gate blocked before execution: recorded here, never delivered as events. */
  blocked: { toolName: string; reason?: string }[] = [];
  /** The aggregate session cost Pi would report; `undefined` models a session that cannot price a run. */
  cost: number | undefined;
  private listeners: Array<(e: PiEvent) => void> = [];
  constructor(private readonly scripts: ScriptStep[], cost?: number) {
    this.cost = cost;
  }
  getSessionStats(): { cost?: number } {
    return { cost: this.cost };
  }
  subscribe(listener: (e: PiEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
  setAskUserQuestionHandler(handler: (questions: AskUserQuestions) => Promise<string>): void {
    this.askHandler = handler;
  }
  setToolCallGate(gate: (toolName: string, input: unknown) => { block?: boolean; reason?: string } | undefined): void {
    this.gate = gate;
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    const step = this.scripts.shift() ?? [];
    const script = typeof step === "function" ? await step() : step;
    // Model Pi's runner consulting the pre-execution gate before a tool runs (DHK-504): a blocked
    // `tool_execution_start` (and its paired `_end`) never reaches subscribers, so the tool does not
    // execute and produces no action/observation - blocked up front, not run-then-annotated.
    const blockedCallIds = new Set<string>();
    for (const ev of script) {
      if (ev.type === "tool_execution_start") {
        const decision = this.gate?.(ev.toolName, ev.args);
        if (decision?.block) {
          this.blocked.push({ toolName: ev.toolName, reason: decision.reason });
          blockedCallIds.add(ev.toolCallId);
          continue;
        }
      }
      if (ev.type === "tool_execution_end" && blockedCallIds.has(ev.toolCallId)) continue;
      for (const l of [...this.listeners]) l(ev);
    }
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

/** An interactive Pi context, optionally carrying an `emitElicit` seam (put on the ctx by the stage
 *  runner for every runtime) and per-stage idle windows. */
const ctxInteractive = (
  over: { emitElicit?: (q: ElicitQuestion) => void; firstReplyMs?: number; idleMs?: number } = {},
): RunnerContext => {
  const { emitElicit, firstReplyMs, idleMs } = over;
  const base = ctx({
    config: {
      runtime: "pi",
      interaction: "interactive",
      ...(firstReplyMs !== undefined ? { firstReplyMs } : {}),
      ...(idleMs !== undefined ? { idleMs } : {}),
    } as RunnerContext["config"],
  });
  return { ...base, ...(emitElicit ? { emitElicit } : {}) } as RunnerContext;
};

const humanTurn = (text: string): HumanTurn => ({ text, ts: "2026-07-18T00:00:00Z" });

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

test("DHK-434 runBatch: reports the session's real dollar cost as costUsd", async () => {
  const fake = new FakePiSession([STAGE_SCRIPT], 0.0421);
  const result = await createPiRunner({ createSession: async () => fake }).runBatch(ctx(), () => {});
  assert.equal(result.status, "ok");
  assert.equal(result.costUsd, 0.0421, "Pi's aggregate session cost is surfaced, not a silent $0");
  assert.ok((result.costUsd ?? 0) > 0);
});

test("DHK-434 runInteractive: reports the session's real dollar cost as costUsd", async () => {
  const fake = new FakePiSession(
    [
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "What is the objective?" } }),
       pe({ type: "turn_end", message: { stopReason: "stop" } })],
      [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Explained the fix." } }),
       pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
    ],
    0.19,
  );
  const result = await createPiRunner({ createSession: async () => fake }).runInteractive(ctx(), turnsFrom([]), () => {});
  assert.equal(result.status, "ok");
  assert.equal(result.costUsd, 0.19, "cost aggregates across all interactive turns incl. the summarise turn");
});

test("DHK-434 runBatch: a session that cannot price a run omits costUsd (never a fabricated $0)", async () => {
  const fake = new FakePiSession([STAGE_SCRIPT]); // cost undefined
  const result = await createPiRunner({ createSession: async () => fake }).runBatch(ctx(), () => {});
  assert.equal(result.status, "ok");
  assert.equal(result.costUsd, undefined, "no cost is reported rather than a misleading 0");
  assert.ok(!("costUsd" in result), "the key is omitted entirely, so the hub reads 'not reported', not '$0'");
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

// DHK-505: Pi elicitation. A mid-stage structured question is surfaced as a Linear `select`
// elicitation via `emitElicit`, and the human's pick returns into the same Pi turn as the tool
// result, reusing the shared router/machinery so behaviour matches the Claude AskUserQuestion path.

test("DHK-505 runInteractive elicit: a structured question reaches emitElicit and the human's pick returns into the turn", async () => {
  const events: TraceEvent[] = [];
  const elicited: ElicitQuestion[] = [];
  const turns = new ManagedMailbox<HumanTurn>();
  let answer: string | undefined;

  const question: AskUserQuestions = [
    {
      question: "Which approach?",
      options: [
        { label: "Option A", description: "the safe one" },
        { label: "Option B", description: "the fast one" },
      ],
      multiSelect: true,
    },
  ];

  const fake = new FakePiSession([
    // Self-seeded opening turn: the model calls ask_user_question, parks on the human, then continues
    // once the pick returns - the shape Pi's live tool `execute` has.
    async () => {
      answer = await fake.askHandler!(question);
      turns.end(); // no further human turns -> the stage settles to gate after this turn
      return [
        pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Proceeding with the pick." } }),
        pe({ type: "turn_end", message: { stopReason: "stop" } }),
      ];
    },
    // Engine-owned summarise turn (turns exhausted -> gate).
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Chose Option B." } }),
     pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
  ]);

  const onTrace = (e: TraceEvent): void => {
    events.push(e);
    // The human replies exactly when the question is raised, mirroring a Linear elicitation reply.
    if (e.type === "elicitation") turns.push(humanTurn("Option B"));
  };
  const result = await createPiRunner({ createSession: async () => fake }).runInteractive(
    ctxInteractive({ emitElicit: (q) => elicited.push(q) }),
    turns,
    onTrace,
  );

  // emitElicit received the exact ElicitQuestion: the prompt folds each option's description, options
  // map label -> { label, value: label }, and multiSelect is carried.
  assert.equal(elicited.length, 1, "the question reached the edge emitElicit seam exactly once");
  assert.equal(elicited[0]!.prompt, "Which approach?\n\n- Option A: the safe one\n- Option B: the fast one");
  assert.deepEqual(elicited[0]!.options, [
    { label: "Option A", value: "Option A" },
    { label: "Option B", value: "Option B" },
  ]);
  assert.equal(elicited[0]!.multiSelect, true, "multiSelect is carried into the ElicitQuestion");
  // The human's pick flows back into the Pi turn as the tool result text (Claude-identical wording).
  assert.equal(answer, "The user selected: Option B");
  // The audit trace `elicitation` event is emitted on raise and is schema-valid.
  const elicitEvt = events.find((e) => e.type === "elicitation");
  assert.ok(elicitEvt, "an elicitation audit trace event is emitted on raise");
  assert.ok(validateEvent(elicitEvt), `schema: ${JSON.stringify(validateEvent.errors)}`);
  assert.equal(result.status, "ok");
});

test("DHK-505 runInteractive elicit: a multi-question batch is asked one at a time and returns Q1..QN answers", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  let answer: string | undefined;
  const questions: AskUserQuestions = [
    { question: "Framework?", options: [{ label: "Vite" }, { label: "Webpack" }] },
    { question: "Language?", options: [{ label: "TS" }, { label: "JS" }] },
  ];
  const replies = ["Vite", "TS"];
  let raised = 0;

  const fake = new FakePiSession([
    async () => {
      answer = await fake.askHandler!(questions);
      turns.end();
      return [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Set up." } }),
              pe({ type: "turn_end", message: { stopReason: "stop" } })];
    },
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done." } }),
     pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
  ]);
  const onTrace = (e: TraceEvent): void => {
    if (e.type === "elicitation") turns.push(humanTurn(replies[raised++]!));
  };
  const result = await createPiRunner({ createSession: async () => fake }).runInteractive(ctxInteractive(), turns, onTrace);

  // Each question is raised only after the previous is answered (one elicit in flight), and the
  // batch returns per-question answers labelled Q1..QN so the model can tie each reply to its question.
  assert.equal(raised, 2, "both questions were raised, one at a time");
  assert.equal(answer, "Q1 (Framework?): The user selected: Vite\nQ2 (Language?): The user selected: TS");
  assert.equal(result.status, "ok");
});

test("DHK-505 runInteractive elicit: a concurrent second ask while one is in flight returns the busy note", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  let answer1: string | undefined;
  let answer2: string | undefined;

  const fake = new FakePiSession([
    // Opening turn: the model fires two concurrent ask_user_question calls. The first sets ref.settle
    // synchronously (inside the Promise constructor); the second sees it and returns busy immediately.
    async () => {
      const q: AskUserQuestions = [{ question: "Which?", options: [{ label: "X" }, { label: "Y" }] }];
      const p1 = fake.askHandler!(q); // sets ref.settle; emits elicitation
      const p2 = fake.askHandler!(q); // ref.settle is non-null -> busy, no onRaise called
      turns.push(humanTurn("X"));     // replies to p1; the router delivers it to ref.settle
      answer1 = await p1;
      answer2 = await p2;
      turns.end();
      return [
        pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OK." } }),
        pe({ type: "turn_end", message: { stopReason: "stop" } }),
      ];
    },
    // Summarise turn (gate exit: turns exhausted after turns.end()).
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done." } }),
     pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
  ]);

  await createPiRunner({ createSession: async () => fake }).runInteractive(ctxInteractive(), turns, () => {});

  assert.equal(answer1, "The user selected: X", "first concurrent ask resolves with the human's pick");
  assert.equal(
    answer2,
    "Only one question can be asked at a time; wait for the current one to be answered, then ask again.",
    "second concurrent ask returns the busy note without calling onRaise",
  );
});

test("DHK-505 runInteractive elicit: no reply within the idle window returns the proceed-anyway note", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  let answer: string | undefined;
  const fake = new FakePiSession([
    async () => {
      // Never a reply: the elicit times out on the (tiny) window.
      answer = await fake.askHandler!([{ question: "Which?", options: [{ label: "X" }, { label: "Y" }] }]);
      turns.end();
      return [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OK." } }),
              pe({ type: "turn_end", message: { stopReason: "stop" } })];
    },
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done." } }),
     pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
  ]);
  const result = await createPiRunner({ createSession: async () => fake }).runInteractive(
    ctxInteractive({ firstReplyMs: 20, idleMs: 20 }),
    turns,
    () => {},
  );
  assert.equal(answer, "No response from the user; proceed with your best judgement.");
  assert.equal(result.status, "ok");
});

test("DHK-505 runInteractive elicit: the turn stream ending mid-question returns the cancelled note", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  let answer: string | undefined;
  const fake = new FakePiSession([
    async () => {
      const pending = fake.askHandler!([{ question: "Which?", options: [{ label: "X" }, { label: "Y" }] }]);
      turns.end(); // the stream ends with the elicit still outstanding -> cancel
      answer = await pending;
      return [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OK." } }),
              pe({ type: "turn_end", message: { stopReason: "stop" } })];
    },
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done." } }),
     pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
  ]);
  const result = await createPiRunner({ createSession: async () => fake }).runInteractive(ctxInteractive(), turns, () => {});
  assert.equal(answer, "The question was cancelled.");
  assert.equal(result.status, "ok");
});

// DHK-511: hermetic per-stage config dir. The live factory writes the OAuth `auth.json` / custom
// `models.json` into a temp dir and points Pi at it; that dir must be torn down when the stage
// settles - on the NORMAL completion path (not only on cancel, where `dispose()` already ran). These
// tests model the factory's decorated `dispose()` (clean up the config dir) and assert the runner
// invokes it on every terminus: an ok batch (via the summarise turn), a failed batch, an interactive
// stage, and cancel.

/** A fake session whose `dispose()` also removes a real per-stage config dir, mirroring how
 *  `defaultCreatePiSession` decorates `dispose` to call `cleanupStageConfigDir`. */
const fakeSessionWithConfigDir = (scripts: ScriptStep[]): { fake: FakePiSession; configDir: string } => {
  const configDir = mkdtempSync(join(tmpdir(), "dahrk-pi-test-"));
  const fake = new FakePiSession(scripts);
  const inner = fake.dispose.bind(fake);
  fake.dispose = (): void => {
    inner();
    rmSync(configDir, { recursive: true, force: true });
  };
  return { fake, configDir };
};

test("DHK-511 teardown: an ok batch stage cleans up its config dir after the summarise turn", async () => {
  const { fake, configDir } = fakeSessionWithConfigDir([
    STAGE_SCRIPT,
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Recap." } }),
     pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
  ]);
  const runner = createPiRunner({ createSession: async () => fake });
  await runner.runBatch(ctx(), () => {});
  assert.ok(existsSync(configDir), "the warm session is kept for summarise, so the dir survives runBatch");
  await runner.summarise(ctx());
  assert.ok(!existsSync(configDir), "the summarise turn is the batch terminus: its config dir is gone");
});

test("DHK-511 teardown: a failed batch stage (no summarise follows) cleans up its config dir", async () => {
  const { fake, configDir } = fakeSessionWithConfigDir([
    [pe({ type: "agent_end", messages: [{ stopReason: "error", errorMessage: "provider 500" }] })],
  ]);
  const result = await createPiRunner({ createSession: async () => fake }).runBatch(ctx(), () => {});
  assert.equal(result.status, "fail");
  assert.ok(!existsSync(configDir), "a failed batch gets no summarise, so runBatch itself tears the dir down");
});

test("DHK-511 teardown: an interactive stage cleans up its config dir on normal settle", async () => {
  const { fake, configDir } = fakeSessionWithConfigDir([
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "What is the objective?" } }),
     pe({ type: "turn_end", message: { stopReason: "stop" } })],
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Explained." } }),
     pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
  ]);
  await createPiRunner({ createSession: async () => fake }).runInteractive(ctx(), turnsFrom([]), () => {});
  assert.ok(!existsSync(configDir), "runInteractive is self-contained: it tears the dir down on settle");
});

test("DHK-511 teardown: cancel also cleans up the config dir", async () => {
  const { fake, configDir } = fakeSessionWithConfigDir([STAGE_SCRIPT]);
  const runner = createPiRunner({ createSession: async () => fake });
  await runner.runBatch(ctx(), () => {});
  assert.ok(existsSync(configDir), "an ok batch keeps the dir for a possible summarise");
  await runner.cancel();
  assert.ok(!existsSync(configDir), "cancel disposes the session and tears the dir down");
});

// DHK-504: Pi pre-execution tool gate. The pure decision mirrors Claude's `policyCanUseTool`: only a
// `deny` verdict blocks (with the policy reason, or a policy-name fallback); `ask`/`allow`/absent pass
// through. Wired into the adapter, a policy-violating tool call is blocked BEFORE it executes.

const ctxWithAuth = (authorizeToolUse?: (tool: string, input: unknown) => PolicyOutcome): PolicyAwareRunnerContext =>
  ({ ...ctx(), ...(authorizeToolUse ? { authorizeToolUse } : {}) }) as PolicyAwareRunnerContext;

test("DHK-504 piToolCallDecision: a deny verdict blocks with the policy's reason", () => {
  const decision = piToolCallDecision(
    ctxWithAuth(() => ({ verdict: "deny", policy: "fs_confine", reason: "write escapes the worktree" })),
    "write",
    { path: "/etc/passwd" },
  );
  assert.deepEqual(decision, { block: true, reason: "write escapes the worktree" });
});

test("DHK-504 piToolCallDecision: a deny with no reason falls back to the policy name", () => {
  const decision = piToolCallDecision(
    ctxWithAuth(() => ({ verdict: "deny", policy: "shell_guard" })),
    "bash",
    { command: "rm -rf /" },
  );
  assert.deepEqual(decision, { block: true, reason: `tool "bash" denied by policy shell_guard` });
});

test("DHK-504 piToolCallDecision: an ask verdict passes through (no divergence from Claude)", () => {
  const decision = piToolCallDecision(ctxWithAuth(() => ({ verdict: "ask", policy: "cost_budget" })), "bash", {});
  assert.equal(decision, undefined);
});

test("DHK-504 piToolCallDecision: an allow verdict passes through", () => {
  const decision = piToolCallDecision(ctxWithAuth(() => ({ verdict: "allow", policy: "none" })), "read", {});
  assert.equal(decision, undefined);
});

test("DHK-504 piToolCallDecision: a ctx without authorizeToolUse passes through (unguarded stage)", () => {
  const decision = piToolCallDecision(ctxWithAuth(), "write", { path: "/etc/passwd" });
  assert.equal(decision, undefined);
});

test("DHK-504 runBatch gate: a session without setToolCallGate runs without error (optional seam backward compat)", async () => {
  // A minimal session that lacks setToolCallGate (an older or batch-only session). The adapter must
  // silently skip gate wiring, not throw, even when a policy would deny.
  const listeners: Array<(e: PiEvent) => void> = [];
  const minimalSession: PiSessionLike = {
    sessionId: "min-1",
    subscribe(l) { listeners.push(l); return () => {}; },
    async prompt() {
      for (const l of listeners) {
        l(pe({ type: "agent_start" }));
        l(pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }));
        l(pe({ type: "agent_end", messages: [{ stopReason: "stop" }] }));
      }
    },
    async abort() {},
    dispose() {},
    // setToolCallGate intentionally absent — models an older session shape
  };
  const authorizeToolUse = (): PolicyOutcome => ({ verdict: "deny", policy: "fs_confine", reason: "escape" });
  const result = await createPiRunner({ createSession: async () => minimalSession }).runBatch(
    { ...ctx(), authorizeToolUse } as RunnerContext,
    () => {},
  );
  assert.equal(result.status, "ok", "missing setToolCallGate does not crash the adapter");
});

test("DHK-504 runInteractive gate: a policy-violating tool call in a human turn is blocked before execution", async () => {
  const events: TraceEvent[] = [];
  const fake = new FakePiSession([
    // Self-seeded opening turn.
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "What to do?" } }),
     pe({ type: "turn_end", message: { stopReason: "stop" } })],
    // Human turn: the model attempts a denied write and an allowed read.
    [
      pe({ type: "tool_execution_start", toolName: "write", toolCallId: "w2", args: { path: "/etc/passwd", content: "x" } }),
      pe({ type: "tool_execution_end", toolCallId: "w2", content: "written", isError: false }),
      pe({ type: "tool_execution_start", toolName: "read", toolCallId: "r2", args: { path: "/tmp/wt/README.md" } }),
      pe({ type: "tool_execution_end", toolCallId: "r2", content: "# Readme", isError: false }),
      pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "read ok" } }),
      pe({ type: "turn_end", message: { stopReason: "stop" } }),
    ],
    // Engine-owned summarise turn (turns exhausted -> gate).
    [pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Used read safely." } }),
     pe({ type: "agent_end", messages: [{ stopReason: "stop" }] })],
  ]);
  const authorizeToolUse = (tool: string): PolicyOutcome =>
    tool === "write"
      ? { verdict: "deny", policy: "fs_confine", reason: "write escapes the worktree" }
      : { verdict: "allow", policy: "none" };

  const result = await createPiRunner({ createSession: async () => fake }).runInteractive(
    {
      ...ctx({ config: { runtime: "pi", interaction: "interactive" } as RunnerContext["config"] }),
      authorizeToolUse,
    } as RunnerContext,
    turnsFrom(["do something"]),
    (e) => events.push(e),
  );

  assert.deepEqual(fake.blocked, [{ toolName: "write", reason: "write escapes the worktree" }],
    "the gate blocks the write in interactive mode before it runs");
  assert.ok(
    !events.some((e) => e.type === "action" && (e as Extract<TraceEvent, { type: "action" }>).tool === "write"),
    "blocked write produces no action event in interactive mode",
  );
  assert.ok(
    !events.some((e) => e.type === "observation" && (e as Extract<TraceEvent, { type: "observation" }>).toolUseId === "w2"),
    "blocked write produces no observation in interactive mode",
  );
  assert.ok(
    events.some((e) => e.type === "action" && (e as Extract<TraceEvent, { type: "action" }>).tool === "read"),
    "the allowed read call still executes and produces an action",
  );
  assert.equal(result.status, "ok");
});

test("DHK-504 runBatch gate: a policy-violating write is blocked before execution, not run-then-annotated", async () => {
  const events: TraceEvent[] = [];
  // The scripted turn calls a denied `write` and an allowed `bash`; the gate must stop only the write.
  const fake = new FakePiSession([
    [
      pe({ type: "agent_start" }),
      pe({ type: "tool_execution_start", toolName: "write", toolCallId: "w1", args: { path: "/etc/passwd", content: "x" } }),
      pe({ type: "tool_execution_end", toolCallId: "w1", content: "written", isError: false }),
      pe({ type: "tool_execution_start", toolName: "bash", toolCallId: "b1", args: { command: "ls" } }),
      pe({ type: "tool_execution_end", toolCallId: "b1", content: "file.txt", isError: false }),
      pe({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }),
      pe({ type: "agent_end", messages: [{ stopReason: "stop" }] }),
    ],
  ]);
  const authorizeToolUse = (tool: string): PolicyOutcome =>
    tool === "write"
      ? { verdict: "deny", policy: "fs_confine", reason: "write escapes the worktree" }
      : { verdict: "allow", policy: "none" };

  await createPiRunner({ createSession: async () => fake }).runBatch(
    { ...ctx(), authorizeToolUse } as RunnerContext,
    (e) => events.push(e),
  );

  // The denied write was stopped up front with the policy reason.
  assert.deepEqual(fake.blocked, [{ toolName: "write", reason: "write escapes the worktree" }]);
  // It never reached onTrace: no action/observation for the blocked call (blocked before execution).
  assert.ok(
    !events.some((e) => e.type === "action" && (e as Extract<TraceEvent, { type: "action" }>).tool === "write"),
    "the blocked write produces no action event - it did not execute",
  );
  assert.ok(
    !events.some((e) => e.type === "observation" && (e as Extract<TraceEvent, { type: "observation" }>).toolUseId === "w1"),
    "the blocked write produces no observation - it was not run-then-annotated",
  );
  // The allowed bash call ran and produced its action + observation exactly as before.
  assert.ok(
    events.some((e) => e.type === "action" && (e as Extract<TraceEvent, { type: "action" }>).tool === "bash"),
    "the allowed bash call executes and produces its action",
  );
  assert.ok(
    events.some((e) => e.type === "observation" && (e as Extract<TraceEvent, { type: "observation" }>).toolUseId === "b1"),
    "the allowed bash call produces its observation",
  );
});
