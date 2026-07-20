/**
 * The shared interactive/batch loop, proven once against a runtime-agnostic `FakeRuntimeSession`.
 *
 * `runInteractiveLoop`/`runBatchLoop` (runner-shared.ts) drive the `RuntimeSession` port - a
 * turn-level seam (`sendTurn`/`summariseTurn`/`cost`/`dispose`) - and never see a `PiEvent` or an
 * `SDKMessage`. This suite scripts a fake session's per-turn `TurnResult`s and asserts the loop's
 * settle state machine across the five exit kinds (tool-exit / gate / timeout / cancel / coalesce)
 * plus self-seeding and `cost()`/`sessionId` surfacing. Pi's and (later) Claude's runtime-specific
 * coverage lives in their own adapter suites; this proves the loop that both drive.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { HumanTurn, RunnerContext } from "@dahrk/contracts";
import {
  runInteractiveLoop,
  runBatchLoop,
  ManagedMailbox,
  type EmittableEvent,
  type RuntimeSession,
  type RuntimeSessionHooks,
  type TurnResult,
} from "../src/runner-shared.js";

/**
 * A scripted `RuntimeSession`: each `sendTurn` shifts the next scripted `TurnResult` (default a
 * plain ok turn), `summariseTurn` returns a fixed sentence, and `cost()`/`sessionId` surface fixed
 * values. It records every turn text, the summarise-call count, and `dispose()`.
 */
class FakeRuntimeSession implements RuntimeSession {
  readonly sessionId?: string;
  turns: string[] = [];
  summariseCalls = 0;
  disposed = false;
  private readonly queue: TurnResult[];
  private readonly summaryText: string;
  private readonly costValue: number | undefined;
  constructor(opts: { results?: TurnResult[]; summary?: string; cost?: number; sessionId?: string } = {}) {
    this.queue = [...(opts.results ?? [])];
    this.summaryText = opts.summary ?? "(fake summary)";
    this.costValue = opts.cost;
    this.sessionId = opts.sessionId;
  }
  async sendTurn(text: string): Promise<TurnResult> {
    this.turns.push(text);
    return this.queue.shift() ?? { stageComplete: false, status: "ok" };
  }
  async summariseTurn(): Promise<string> {
    this.summariseCalls++;
    return this.summaryText;
  }
  cost(): number | undefined {
    return this.costValue;
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** A `RuntimeSession` whose `sendTurn` throws, to drive the loop's runtime-error boundary. */
class ThrowingRuntimeSession implements RuntimeSession {
  readonly sessionId = "throw-sess";
  constructor(private readonly message: string) {}
  async sendTurn(): Promise<TurnResult> {
    throw new Error(this.message);
  }
  async summariseTurn(): Promise<string> {
    return "(unused)";
  }
  cost(): number | undefined {
    return undefined;
  }
  dispose(): void {}
}

const ctx = (over: Partial<RunnerContext> = {}): RunnerContext => ({
  config: { runtime: "pi", interaction: "interactive" } as RunnerContext["config"],
  workspace: { worktreePath: "/tmp/wt", branch: "main" } as RunnerContext["workspace"],
  issueContext: "Fix the failing tests.",
  ...over,
});

/** An interactive ctx with tiny idle windows so the timeout path settles fast. */
const fastCtx = (over: Partial<RunnerContext> = {}): RunnerContext =>
  ctx({
    config: { runtime: "pi", interaction: "interactive", firstReplyMs: 20, idleMs: 20 } as RunnerContext["config"],
    ...over,
  });

const makeHooks = (events: EmittableEvent[] = []): RuntimeSessionHooks => ({
  emit: (e) => events.push(e),
  ask: async () => "No response from the user; proceed with your best judgement.",
});

const opts = (over: Partial<Parameters<typeof runInteractiveLoop>[4]> = {}) => {
  const controller = new AbortController();
  return {
    controller,
    value: {
      signal: controller.signal,
      cancelled: () => false,
      cancel: async () => {},
      instructionInSystemPrompt: false,
      ...over,
    } as Parameters<typeof runInteractiveLoop>[4],
  };
};

/** An async iterable that never yields and never ends: models "no human is watching yet". */
const neverTurns = (): AsyncIterable<HumanTurn> => new ManagedMailbox<HumanTurn>();

const emptyTurns = (): AsyncIterable<HumanTurn> => ({
  // eslint-disable-next-line require-yield
  async *[Symbol.asyncIterator]() {
    return;
  },
});

test("interactive tool-exit: the opening turn's stage-complete ends the stage with its summary, no summarise turn", async () => {
  const session = new FakeRuntimeSession({
    results: [{ stageComplete: true, summary: "Refactored the parser.", status: "ok" }],
  });
  const { value } = opts();
  const result = await runInteractiveLoop(session, ctx(), neverTurns(), makeHooks(), value);

  assert.equal(result.status, "ok");
  assert.equal(result.summary, "Refactored the parser.");
  assert.equal(session.summariseCalls, 0, "a tool exit needs no engine summarise turn");
  assert.equal(session.turns.length, 1, "only the self-seeded opening turn ran");
});

test("interactive self-seed: the opening sendTurn fires from the resolved prompt before any human turn", async () => {
  const session = new FakeRuntimeSession();
  const { value } = opts();
  await runInteractiveLoop(session, ctx(), emptyTurns(), makeHooks(), value);

  assert.match(session.turns[0] ?? "", /Fix the failing tests\./, "the seed folds in the ticket brief");
});

test("interactive gate: turns exhausted calls summariseTurn once and returns its text", async () => {
  const session = new FakeRuntimeSession({ summary: "Explained the fix; tests pass." });
  const { value } = opts();
  const result = await runInteractiveLoop(session, ctx(), emptyTurns(), makeHooks(), value);

  assert.equal(result.status, "ok");
  assert.equal(result.summary, "Explained the fix; tests pass.");
  assert.equal(session.summariseCalls, 1);
});

test("interactive timeout: no reply within the idle window settles timeout and invokes cancel", async () => {
  const session = new FakeRuntimeSession();
  let cancelCalls = 0;
  const { value } = opts({ cancel: async () => void cancelCalls++ });
  const result = await runInteractiveLoop(session, fastCtx(), neverTurns(), makeHooks(), value);

  assert.equal(result.status, "timeout");
  assert.equal(result.summary, "(stage timed out awaiting input)");
  assert.equal(cancelCalls, 1, "the timeout path cancels the runner");
  assert.equal(session.summariseCalls, 0);
});

test("interactive cancel: an aborted signal settles fail with the cancelled summary, no summarise turn", async () => {
  const session = new FakeRuntimeSession();
  const { controller, value } = opts();
  controller.abort(); // pre-abort: the first race after the seed sees the cancel
  const result = await runInteractiveLoop(session, ctx(), neverTurns(), makeHooks(), value);

  assert.equal(result.status, "fail");
  assert.equal(result.summary, "(stage cancelled)");
  assert.equal(session.summariseCalls, 0);
});

test("interactive coalesce: a burst of rapid turns within COALESCE_MS collapses into one sendTurn", async () => {
  const session = new FakeRuntimeSession();
  const turns = new ManagedMailbox<HumanTurn>();
  turns.push({ text: "a", ts: "t" });
  turns.push({ text: "b", ts: "t" });
  turns.end();
  const { value } = opts();
  await runInteractiveLoop(session, ctx(), turns, makeHooks(), value);

  assert.equal(session.turns[1], "a\nb", "the burst is joined into a single prompt after the seed");
  assert.equal(session.turns.length, 2, "seed + one coalesced human turn");
  assert.equal(session.summariseCalls, 1, "turns then exhaust -> gate summarise");
});

test("interactive: cost() and sessionId are surfaced onto the result", async () => {
  const session = new FakeRuntimeSession({ cost: 0.19, sessionId: "pi-sess-1" });
  const { value } = opts();
  const result = await runInteractiveLoop(session, ctx(), emptyTurns(), makeHooks(), value);

  assert.equal(result.costUsd, 0.19);
  assert.equal(result.sessionId, "pi-sess-1");
});

test("interactive: an unpriced session omits costUsd entirely (never a fabricated $0)", async () => {
  const session = new FakeRuntimeSession(); // cost undefined
  const { value } = opts();
  const result = await runInteractiveLoop(session, ctx(), emptyTurns(), makeHooks(), value);

  assert.equal(result.costUsd, undefined);
  assert.ok(!("costUsd" in result));
});

test("batch: one sendTurn settles ok and surfaces cost + sessionId", async () => {
  const session = new FakeRuntimeSession({ results: [{ stageComplete: false, status: "ok" }], cost: 0.04, sessionId: "b1" });
  const result = await runBatchLoop(session, ctx(), makeHooks(), { cancelled: () => false });

  assert.equal(result.status, "ok");
  assert.equal(result.costUsd, 0.04);
  assert.equal(result.sessionId, "b1");
  assert.match(session.turns[0] ?? "", /Fix the failing tests\./, "batch sends the resolved stage prompt");
});

test("batch: a thrown sendTurn emits runtime_error and settles fail", async () => {
  const events: EmittableEvent[] = [];
  const session = new ThrowingRuntimeSession("network timeout");
  const result = await runBatchLoop(session, ctx(), makeHooks(events), { cancelled: () => false });

  assert.equal(result.status, "fail");
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error");
  assert.equal(err.kind, "runtime_error");
  assert.equal(err.message, "network timeout");
});

test("batch: a cancelled runner settles fail and suppresses the runtime_error emit", async () => {
  const events: EmittableEvent[] = [];
  const session = new ThrowingRuntimeSession("late abort");
  const result = await runBatchLoop(session, ctx(), makeHooks(events), { cancelled: () => true });

  assert.equal(result.status, "fail");
  assert.ok(!events.some((e) => e.type === "error"), "a cancel-driven throw is not reported as a runtime error");
});
