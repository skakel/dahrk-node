/**
 * The shared interactive/batch loop, proven once against a runtime-agnostic `FakeRuntimeSession`.
 *
 * `runInteractiveLoop`/`runBatchLoop` (turn-loop.ts) drive the `RuntimeSession` port - a
 * turn-level seam (`sendTurn`/`summariseTurn`/`cost`/`dispose`) - and never see a `PiEvent` or an
 * `SDKMessage`. This suite scripts a fake session's per-turn `TurnResult`s and asserts the loop's
 * settle state machine across the five exit kinds (tool-exit / gate / timeout / cancel / coalesce)
 * plus self-seeding and `cost()`/`sessionId` surfacing. Pi's and (later) Claude's runtime-specific
 * coverage lives in their own adapter suites; this proves the loop that both drive.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ElicitQuestion, HumanTurn, RunnerContext } from "@dahrk/contracts";
import { runInteractiveLoop, runBatchLoop, classifyRuntimeError } from "../src/turn-loop.js";
import { ManagedMailbox } from "../src/mailbox.js";
import type {
  EmittableEvent,
  RuntimeSession,
  RuntimeSessionHooks,
  TurnResult,
} from "../src/runtime-session.js";

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

/**
 * Drive the interactive loop against a pre-built fake session. The loop now owns session construction:
 * it assembles the router-backed hooks and calls a factory to build the session, so the test supplies
 * an `emit` sink and a factory that returns the fake. `ask` is assembled by the loop, not the test.
 */
const runInteractive = (
  session: RuntimeSession,
  c: RunnerContext,
  turns: AsyncIterable<HumanTurn>,
  value: Parameters<typeof runInteractiveLoop>[4],
  events: EmittableEvent[] = [],
): Promise<Awaited<ReturnType<typeof runInteractiveLoop>>> =>
  runInteractiveLoop(c, turns, (e) => events.push(e), () => session, value);

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
  const result = await runInteractive(session, ctx(), neverTurns(), value);

  assert.equal(result.status, "ok");
  assert.equal(result.summary, "Refactored the parser.");
  assert.equal(session.summariseCalls, 0, "a tool exit needs no engine summarise turn");
  assert.equal(session.turns.length, 1, "only the self-seeded opening turn ran");
});

test("interactive self-seed: the opening sendTurn fires from the resolved prompt before any human turn", async () => {
  const session = new FakeRuntimeSession();
  const { value } = opts();
  await runInteractive(session, ctx(), emptyTurns(), value);

  assert.match(session.turns[0] ?? "", /Fix the failing tests\./, "the seed folds in the ticket brief");
});

test("interactive gate: turns exhausted calls summariseTurn once and returns its text", async () => {
  const session = new FakeRuntimeSession({ summary: "Explained the fix; tests pass." });
  const { value } = opts();
  const result = await runInteractive(session, ctx(), emptyTurns(), value);

  assert.equal(result.status, "ok");
  assert.equal(result.summary, "Explained the fix; tests pass.");
  assert.equal(session.summariseCalls, 1);
});

test("interactive timeout: no reply within the idle window settles timeout and invokes cancel", async () => {
  const session = new FakeRuntimeSession();
  let cancelCalls = 0;
  const { value } = opts({ cancel: async () => void cancelCalls++ });
  const result = await runInteractive(session, fastCtx(), neverTurns(), value);

  assert.equal(result.status, "timeout");
  assert.equal(result.summary, "(stage timed out awaiting input)");
  assert.equal(cancelCalls, 1, "the timeout path cancels the runner");
  assert.equal(session.summariseCalls, 0);
});

test("interactive cancel: an aborted signal settles fail with the cancelled summary, no summarise turn", async () => {
  const session = new FakeRuntimeSession();
  const { controller, value } = opts();
  controller.abort(); // pre-abort: the first race after the seed sees the cancel
  const result = await runInteractive(session, ctx(), neverTurns(), value);

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
  await runInteractive(session, ctx(), turns, value);

  assert.equal(session.turns[1], "a\nb", "the burst is joined into a single prompt after the seed");
  assert.equal(session.turns.length, 2, "seed + one coalesced human turn");
  assert.equal(session.summariseCalls, 1, "turns then exhaust -> gate summarise");
});

test("interactive: cost() and sessionId are surfaced onto the result", async () => {
  const session = new FakeRuntimeSession({ cost: 0.19, sessionId: "pi-sess-1" });
  const { value } = opts();
  const result = await runInteractive(session, ctx(), emptyTurns(), value);

  assert.equal(result.costUsd, 0.19);
  assert.equal(result.sessionId, "pi-sess-1");
});

test("interactive: an unpriced session omits costUsd entirely (never a fabricated $0)", async () => {
  const session = new FakeRuntimeSession(); // cost undefined
  const { value } = opts();
  const result = await runInteractive(session, ctx(), emptyTurns(), value);

  assert.equal(result.costUsd, undefined);
  assert.ok(!("costUsd" in result));
});

test("interactive elicit routing: a session that calls hooks.ask mid-turn reaches the router-backed ask handed in at construction", async () => {
  // Proves the loop assembles the router-backed `ask` and hands it to the session via the factory - the
  // seam that used to be a mutated `hooks.ask` field read lazily by the adapters. The fake raises an
  // elicitation on its opening turn; the queued human turn settles it through the shared router.
  const turns = new ManagedMailbox<HumanTurn>();
  const events: EmittableEvent[] = [];
  let captured: RuntimeSessionHooks | undefined;
  let askReply: string | undefined;
  const session: RuntimeSession = {
    async sendTurn(): Promise<TurnResult> {
      if (askReply === undefined) {
        const pending = captured!.ask({
          prompt: "Pick one",
          options: [{ label: "A" }, { label: "B" }],
        } as ElicitQuestion);
        // `ask` registers with the router synchronously, so a turn pushed now settles it as the reply.
        turns.push({ text: "B", ts: "t" });
        turns.end();
        askReply = await pending;
      }
      return { stageComplete: false, status: "ok" };
    },
    async summariseTurn(): Promise<string> {
      return "(fake summary)";
    },
    cost: () => undefined,
    dispose: () => {},
  };
  const { value } = opts();
  const result = await runInteractiveLoop(
    ctx(),
    turns,
    (e) => events.push(e),
    (hooks) => {
      captured = hooks;
      return session;
    },
    value,
  );

  assert.equal(askReply, "The user selected: B", "the reply routes through the shared elicit router");
  assert.equal(result.status, "ok");
  const elicit = events.find((e) => e.type === "elicitation");
  assert.ok(elicit && elicit.type === "elicitation", "the raised question emitted an elicitation trace event");
  assert.equal(elicit.prompt, "Pick one");
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

test("batch: an upstream API transient throw settles fail with failureClass external and a truthful summary (DHK-569)", async () => {
  const events: EmittableEvent[] = [];
  const session = new ThrowingRuntimeSession("API Error: Stream idle timeout - partial response received");
  const result = await runBatchLoop(session, ctx(), makeHooks(events), { cancelled: () => false });

  assert.equal(result.status, "fail");
  assert.equal(result.failureClass, "external", "an upstream transient is attributed external, not agent");
  assert.match(result.summary ?? "", /stream idle timeout/i, "the summary names the transient rather than a bare fail");
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error" && err.kind === "runtime_error", "the runtime_error is still emitted");
});

test("batch: a genuine agent-task failure stays unclassified so the engine still bills it agent (DHK-569)", async () => {
  // A non-transient throw: nothing about the upstream API, so the adapter must NOT claim external.
  const throwResult = await runBatchLoop(
    new ThrowingRuntimeSession("assertion failed: expected 3 tests to pass"),
    ctx(),
    makeHooks(),
    { cancelled: () => false },
  );
  assert.equal(throwResult.status, "fail");
  assert.equal(throwResult.failureClass, undefined, "a genuine task failure carries no failureClass");
  assert.equal(throwResult.summary, undefined, "no synthetic transient summary is attached");

  // A plain `status: fail` turn (no throw at all) is likewise the agent's own verdict.
  const session = new FakeRuntimeSession({ results: [{ stageComplete: false, status: "fail" }] });
  const failResult = await runBatchLoop(session, ctx(), makeHooks(), { cancelled: () => false });
  assert.equal(failResult.status, "fail");
  assert.equal(failResult.failureClass, undefined, "a plain fail turn stays unclassified");
});

test("batch: a cancel-driven transient throw is NOT attributed external (DHK-569)", async () => {
  // When the harness watchdog cancels the runner, sendTurn throws mid-stream. That throw is not an
  // upstream transient we should own here - the stage-runner owns the watchdog attribution - so the
  // loop leaves failureClass unset under `cancelled`.
  const session = new ThrowingRuntimeSession("API Error: Stream idle timeout - partial response received");
  const result = await runBatchLoop(session, ctx(), makeHooks(), { cancelled: () => true });
  assert.equal(result.status, "fail");
  assert.equal(result.failureClass, undefined, "a cancel-driven throw is never classified by the loop");
});

test("classifyRuntimeError recognises the upstream-transient vocabulary and nothing else (DHK-569)", () => {
  for (const transient of [
    "API Error: Stream idle timeout - partial response received",
    "Overloaded",
    "529 overloaded_error",
    "429 Too Many Requests: rate limit exceeded",
    "504 Gateway Timeout",
    "500 Internal Server Error",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "read ECONNRESET",
    "socket hang up",
  ]) {
    assert.equal(classifyRuntimeError(transient), "external", `\`${transient}\` should class external`);
  }
  for (const agentSide of [
    "assertion failed: expected 3 tests to pass",
    "TypeError: cannot read property 'x' of undefined",
    "the plan did not compile",
    "",
  ]) {
    assert.equal(classifyRuntimeError(agentSide), undefined, `\`${agentSide}\` should stay unclassified`);
  }
});
