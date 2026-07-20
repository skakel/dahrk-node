/**
 * Claude runtime adapter characterisation tests (DHK-592). Before this file, `createClaudeRunner`
 * was instantiated in ZERO tests: Claude's interactive settle logic (tool-exit / gate-summarise /
 * idle-timeout / cancel / burst-coalescing) was entirely uncovered end-to-end. Only its extracted
 * pure helpers were tested.
 *
 * The real `@anthropic-ai/claude-agent-sdk` `query()` makes live inference calls and needs
 * credentials, so we drive the adapter through its injected session factory
 * (`ClaudeRunnerDeps.createSession`) with a scripted `FakeClaudeSession`: a per-turn queue of SDK
 * messages replayed synchronously when the loop pushes a user turn, plus a write path
 * (`StageCompleteTool.capture`) for the tool-exit turn. No live calls, no credentials. These tests
 * PIN today's behaviour (status, summary, sessionId, costUsd, artifact) across every exit kind so the
 * later loop-extraction (DHK-593/DHK-594) is safe.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { HumanTurn, RunnerContext } from "@dahrk/contracts";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createClaudeRunner,
  type ClaudeSessionInit,
  type ClaudeSessionLike,
} from "../src/claude-adapter.js";
import type { StageCompleteTool } from "../src/stage-complete-tool.js";
import { ManagedMailbox, SUMMARISE_PROMPT } from "../src/runner-shared.js";
import { makeRunner } from "../src/index.js";

const cm = (x: unknown): SDKMessage => x as SDKMessage;

/** An assistant text message carrying a session id (the adapter captures the id off any message). */
const asst = (text: string, sessionId = "claude-sess-1"): SDKMessage =>
  cm({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "text", text }] } });

/** A turn-settling `result` message: `subtype` decides ok/fail, `total_cost_usd` feeds costUsd, and
 *  `result` is the text the batch `summarise()` reads. */
const resultMsg = (
  over: { status?: "ok" | "fail"; cost?: number; sessionId?: string; text?: string } = {},
): SDKMessage => {
  const { status = "ok", cost, sessionId = "claude-sess-1", text = "" } = over;
  return cm({
    type: "result",
    subtype: status === "ok" ? "success" : "error_during_execution",
    session_id: sessionId,
    ...(cost !== undefined ? { total_cost_usd: cost } : {}),
    usage: {},
    duration_ms: 1,
    result: text,
  });
};

/** A per-turn script: a fixed list of SDK messages to replay, or a thunk producing them (the
 *  tool-exit turn is a thunk that calls `stageTool.capture` before emitting its result, the way the
 *  live SDK's MCP handler would). */
type ClaudeScriptStep = SDKMessage[] | (() => SDKMessage[] | Promise<SDKMessage[]>);

/**
 * A scripted fake Claude session. Each `push()` (seed / coalesced human turn / summarise prompt)
 * records the pushed user text and replays the next per-turn script into an internal message queue
 * the adapter's async iterator drains - modelling the SDK's streaming loop where one user message
 * drives exactly one turn to a `result`. A one-shot batch/summarise session (created with a `prompt`)
 * replays its single script and ends the stream, matching a non-streaming `query()`.
 */
class FakeClaudeSession implements ClaudeSessionLike {
  /** The user texts pushed to the session, in order (seed first). */
  prompts: string[] = [];
  closed = false;
  ended = false;
  interrupted = false;
  /** The stage-complete handle the factory is handed; a tool-exit thunk drives it via `capture`. */
  stageTool?: StageCompleteTool;
  private inbox = new ManagedMailbox<SDKMessage>();
  constructor(private readonly scripts: ClaudeScriptStep[]) {}

  /** The injected factory body: capture the stage-tool handle and, for a one-shot batch/summarise
   *  session (a `prompt` is present), replay the single script and end the stream. */
  bind(init: ClaudeSessionInit): ClaudeSessionLike {
    this.inbox = new ManagedMailbox<SDKMessage>();
    this.stageTool = init.stageTool;
    if (init.prompt !== undefined) {
      this.prompts.push(init.prompt);
      void this.replayAndEnd();
    }
    return this;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.inbox[Symbol.asyncIterator]();
  }

  push(msg: SDKUserMessage): void {
    this.prompts.push(typeof msg.message.content === "string" ? msg.message.content : "");
    void this.replayNext();
  }

  end(): void {
    this.ended = true;
    this.inbox.end();
  }

  close(): void {
    this.closed = true;
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  private async replayNext(): Promise<void> {
    const step = this.scripts.shift() ?? [];
    const msgs = typeof step === "function" ? await step() : step;
    for (const m of msgs) this.inbox.push(m);
  }

  private async replayAndEnd(): Promise<void> {
    await this.replayNext();
    this.inbox.end();
  }
}

const baseWorkspace = {
  repoId: "r",
  gitUrl: "https://github.com/skakel/skakel-test.git",
  repo: "r",
  baseBranch: "main",
  worktreePath: "/tmp/wt",
  scratchPath: "/tmp/wt/.dahrk/scratch",
};

const ctxBatch = (): RunnerContext =>
  ({
    config: { runtime: "claude-code", interaction: "batch" },
    workspace: baseWorkspace,
    issueContext: "Fix the failing tests.",
  }) as RunnerContext;

const ctxInteractive = (
  over: { exit?: string; emitArtifact?: string; firstReplyMs?: number; idleMs?: number } = {},
): RunnerContext =>
  ({
    config: {
      runtime: "claude-code",
      interaction: "interactive",
      ...(over.exit ? { exit: over.exit } : {}),
      ...(over.emitArtifact ? { emitArtifact: over.emitArtifact } : {}),
      ...(over.firstReplyMs !== undefined ? { firstReplyMs: over.firstReplyMs } : {}),
      ...(over.idleMs !== undefined ? { idleMs: over.idleMs } : {}),
    },
    workspace: baseWorkspace,
    issueContext: "Fix the failing tests.",
  }) as RunnerContext;

const humanTurn = (text: string): HumanTurn => ({ text, ts: "2026-07-20T00:00:00Z" });

const turnsFrom = (texts: string[]): AsyncIterable<HumanTurn> => ({
  async *[Symbol.asyncIterator]() {
    for (const t of texts) yield humanTurn(t);
  },
});

test("makeRunner('claude-code') returns a claude runner without importing the live SDK", () => {
  const runner = makeRunner("claude-code");
  assert.equal(runner.runtime, "claude-code");
});

// --- Interactive characterisation: one test per exit kind (the coverage gap this ticket closes) ---

test("runInteractive tool exit: the stage-complete tool settles ok and hands back its summary + document", async () => {
  const fake = new FakeClaudeSession([
    // Self-seeded opening turn.
    [asst("What should I do?"), resultMsg({})],
    // The human turn drives a tool-exit: the SDK would run the MCP tool; the fake calls capture directly.
    () => {
      fake.stageTool!.capture({ summary: "Refactored the parser.", document: "# Spec\n\nThe plan." });
      return [asst("Done."), resultMsg({ cost: 0.05 })];
    },
  ]);
  const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });

  const out = await runner.runInteractive(ctxInteractive({ exit: "tool" }), turnsFrom(["do the work"]), () => {});

  assert.equal(out.status, "ok");
  assert.equal(out.summary, "Refactored the parser.");
  // The handed-back document rides out as the stage artifact at the default scratch path.
  assert.deepEqual(out.artifact, { path: ".dahrk/scratch/output/document.md", content: "# Spec\n\nThe plan." });
  assert.equal(out.sessionId, "claude-sess-1");
  assert.equal(out.costUsd, 0.05);
});

test("runInteractive tool exit: emitArtifact overrides the handed-back document path", async () => {
  const fake = new FakeClaudeSession([
    [asst("Opening."), resultMsg({})],
    () => {
      fake.stageTool!.capture({ summary: "Wrote the spec.", document: "# Doc" });
      return [asst("Done."), resultMsg({})];
    },
  ]);
  const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });

  const out = await runner.runInteractive(
    ctxInteractive({ exit: "tool", emitArtifact: "docs/spec.md" }),
    turnsFrom(["go"]),
    () => {},
  );

  assert.deepEqual(out.artifact, { path: "docs/spec.md", content: "# Doc" });
});

test("runInteractive gate exit: turns exhausted -> the engine pushes SUMMARISE_PROMPT and the recap is the summary", async () => {
  const fake = new FakeClaudeSession([
    // Self-seeded opening turn (no tool fires).
    [asst("What is the objective?"), resultMsg({})],
    // The engine-owned summarise turn (turns exhausted -> gate).
    [asst("Ran the suite; all three tests pass."), resultMsg({ cost: 0.02 })],
  ]);
  const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });

  const out = await runner.runInteractive(ctxInteractive(), turnsFrom([]), () => {});

  assert.equal(out.status, "ok");
  assert.equal(out.summary, "Ran the suite; all three tests pass.");
  // No tool fired, so no document handback -> no artifact.
  assert.ok(!("artifact" in out), "a gate exit hands back no document artifact");
  // The last user turn pushed is the engine's summarise prompt, not a human turn.
  assert.equal(fake.prompts.at(-1), SUMMARISE_PROMPT);
  assert.equal(out.sessionId, "claude-sess-1");
  assert.equal(out.costUsd, 0.02);
});

test("runInteractive idle timeout: no human reply within the window settles timeout and interrupts the session", async () => {
  // A mailbox that is never pushed nor ended: after the seed turn, raceNextTurn times out (it is NOT
  // turns-exhausted, which would gate instead).
  const turns = new ManagedMailbox<HumanTurn>();
  const fake = new FakeClaudeSession([[asst("What is the objective?"), resultMsg({})]]);
  const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });

  const out = await runner.runInteractive(ctxInteractive({ firstReplyMs: 20, idleMs: 20 }), turns, () => {});

  assert.equal(out.status, "timeout");
  assert.equal(out.summary, "(stage timed out awaiting input)");
  assert.equal(fake.interrupted, true, "the timeout path cancels, interrupting the in-flight session");
});

test("runInteractive cancel: cancelling mid-stage settles fail and interrupts the session", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  const fake = new FakeClaudeSession([[asst("What is the objective?"), resultMsg({})]]);
  const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });

  const pending = runner.runInteractive(ctxInteractive(), turns, () => {});
  await runner.cancel();
  const out = await pending;

  assert.equal(out.status, "fail");
  assert.equal(out.summary, "(stage cancelled)");
  assert.equal(fake.interrupted, true);
});

test("runInteractive burst coalescing: rapid queued turns fold into one user message", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  const fake = new FakeClaudeSession([
    // Self-seeded opening turn.
    [asst("What should I do?"), resultMsg({})],
    // The coalesced human turn (t1 + t2 + t3 as one message).
    [asst("Working through them."), resultMsg({})],
    // The engine-owned summarise turn (turns exhausted after the burst -> gate).
    [asst("Handled t1, t2 and t3."), resultMsg({ cost: 0.03 })],
  ]);
  const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });

  // Queue a burst up front, then end: the debounce folds all three already-queued turns into one.
  turns.push(humanTurn("t1"));
  turns.push(humanTurn("t2"));
  turns.push(humanTurn("t3"));
  turns.end();

  const out = await runner.runInteractive(ctxInteractive(), turns, () => {});

  // prompts[0] is the seed; prompts[1] is the single coalesced user message; prompts[2] the summarise.
  assert.equal(fake.prompts[1], "t1\nt2\nt3", "the burst coalesced into one user message");
  assert.equal(fake.prompts.at(-1), SUMMARISE_PROMPT);
  assert.equal(out.status, "ok");
  assert.equal(out.summary, "Handled t1, t2 and t3.");
});

// --- Default-seam-unchanged guards: the factory wrap left batch/summarise outputs unchanged ---

test("runBatch: settles ok and surfaces the session's sessionId and costUsd", async () => {
  const fake = new FakeClaudeSession([[asst("Ran the tests."), resultMsg({ cost: 0.04 })]]);
  const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });

  const out = await runner.runBatch(ctxBatch(), () => {});

  assert.equal(out.status, "ok");
  assert.equal(out.sessionId, "claude-sess-1");
  assert.equal(out.costUsd, 0.04);
  assert.match(fake.prompts[0] ?? "", /Fix the failing tests\./, "resolveStagePrompt folds in the ticket brief");
});

test("summarise: reuses the warm session's id and returns the handoff sentence from the result text", async () => {
  const fake = new FakeClaudeSession([
    // Batch turn (establishes the session id summarise resumes).
    [asst("Ran the tests."), resultMsg({ cost: 0.04 })],
    // The constrained summarise turn: its `result` text is the handoff sentence.
    [resultMsg({ text: "Ran the suite; all three tests pass." })],
  ]);
  const runner = createClaudeRunner({ createSession: (init) => fake.bind(init) });

  await runner.runBatch(ctxBatch(), () => {});
  const summary = await runner.summarise(ctxBatch());

  assert.equal(summary, "Ran the suite; all three tests pass.");
  assert.equal(fake.prompts.at(-1), SUMMARISE_PROMPT, "the summarise turn sends the engine-owned prompt");
});
