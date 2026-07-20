/**
 * The shared interactive and batch loops that drive the `RuntimeSession` port. Runtime-agnostic: they
 * read ONLY the port and the run context, so embedded Pi, container Pi and Claude all drive the one
 * body. Owns the interactive `exited: tool|gate|timeout|cancelled` state machine, the idle/coalesce
 * timing, and (on a gate exit) the single engine-owned `summariseTurn()`. Builds the elicit router and
 * exposes it as `hooks.ask`, so a session's structured-question tool routes through the shared
 * one-at-a-time / no-reply / cancel machinery.
 */
import type {
  ElicitQuestion,
  HumanTurn,
  JobResult,
  JobStatus,
  RunnerContext,
} from "@dahrk/contracts";
import { interactiveSeedText, resolveStagePrompt } from "./prompt-assembly.js";
import { createElicitTurnRouter, elicitOutcomeReply } from "./elicit-router.js";
import type {
  PolicyAwareRunnerContext,
  RuntimeSession,
  RuntimeSessionFactory,
  RuntimeSessionHooks,
} from "./runtime-session.js";

/**
 * The idle windows (ms) an interactive stage waits for human input. Two distinct windows:
 *  - `firstReplyMs`: awaiting the FIRST human reply to the agent's opening question. A human needs
 *    longer here (read the ticket, think, compose the first answer) than to continue a live
 *    back-and-forth, and a label/mention-triggered stage often has nobody watching yet.
 *  - `idleMs`: awaiting each subsequent turn once the conversation is under way.
 * Both default from env and are overridable per stage via `AgentConfig` (engine-threaded from the
 * workflow stage). `firstReplyMs` is clamped to at least `idleMs`: the opening answer must never get
 * a shorter budget than a mid-interview follow-up. Historic default was a single 120s window, which
 * timed out label-triggered interviews before anyone could answer (run-152a526f).
 */
export function interactiveIdleWindows(ctx: RunnerContext): { firstReplyMs: number; idleMs: number } {
  const idleMs = ctx.config.idleMs ?? Number(process.env.DAHRK_INTERACTIVE_IDLE_MS ?? process.env.SKAKEL_INTERACTIVE_IDLE_MS ?? 120_000);
  const firstReplyMs = ctx.config.firstReplyMs ?? Number(process.env.DAHRK_INTERACTIVE_FIRST_REPLY_MS ?? process.env.SKAKEL_INTERACTIVE_FIRST_REPLY_MS ?? 600_000);
  return { firstReplyMs: Math.max(firstReplyMs, idleMs), idleMs };
}

/** The outcome of racing the next human turn against the idle deadline and a cancel signal. */
export type RaceResult<T> =
  | { kind: "turn"; value: T }
  | { kind: "turns-exhausted" }
  | { kind: "idle-timeout" }
  | { kind: "cancelled" };

/**
 * Race a caller-held `pending` next()-promise against an idle timeout (fails closed) and a
 * cancel signal. The caller owns the promise so it can reuse the SAME pending across the idle
 * wait and the coalescing debounce - on an `idle-timeout` the promise is still live and is
 * carried into the next call, so a blocking iterable never drops a turn. On a `turn`/
 * `turns-exhausted` result the promise has resolved and the caller starts a fresh `next()`.
 */
export function raceNextTurn<T>(
  pending: Promise<IteratorResult<T>>,
  idleMs: number,
  signal: AbortSignal,
): Promise<RaceResult<T>> {
  return new Promise<RaceResult<T>>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function finish(r: RaceResult<T>): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(r);
    }
    function onAbort(): void {
      finish({ kind: "cancelled" });
    }
    if (signal.aborted) {
      finish({ kind: "cancelled" });
      return;
    }
    signal.addEventListener("abort", onAbort);
    timer = setTimeout(() => finish({ kind: "idle-timeout" }), idleMs);
    pending.then(
      (res) => finish(res.done ? { kind: "turns-exhausted" } : { kind: "turn", value: res.value }),
      () => finish({ kind: "turns-exhausted" }),
    );
  });
}

/**
 * Debounce window (ms) for coalescing a burst of rapid human turns into one prompt. Shared by the
 * interactive loop below so every runtime (both Pi back-ends and Claude) debounces identically - the
 * single copy now that Claude drives this loop too (DHK-594).
 */
export const COALESCE_MS = Number(process.env.DAHRK_COALESCE_MS ?? process.env.SKAKEL_COALESCE_MS ?? 40);

/** The loop-owned lifecycle levers the interactive settle needs: the cancel signal, a live `cancelled`
 *  predicate (runner state), the runner's `cancel()` (fired on timeout), and whether the stage
 *  instruction already rides in the runtime's system prompt (so the seed can be a short kickoff). */
export interface InteractiveLoopOptions {
  signal: AbortSignal;
  cancelled: () => boolean;
  cancel: () => Promise<void>;
  instructionInSystemPrompt: boolean;
}

/**
 * The shared interactive loop: seed -> race the next human turn against the idle deadline and cancel
 * -> coalesce a rapid burst -> settle. It owns the `exited: tool|gate|timeout|cancelled` state machine
 * and, on a gate exit, the single engine-owned `summariseTurn()`. It reads ONLY the `RuntimeSession`
 * port, so embedded Pi, container Pi and (later) Claude all drive this one body. The elicit router is
 * built here and exposed as `hooks.ask`, so a session's structured-question tool routes through the
 * shared one-at-a-time / no-reply / cancel machinery.
 */
export async function runInteractiveLoop(
  ctx: PolicyAwareRunnerContext,
  turns: AsyncIterable<HumanTurn>,
  emit: RuntimeSessionHooks["emit"],
  makeSession: RuntimeSessionFactory,
  opts: InteractiveLoopOptions,
): Promise<Omit<JobResult, "jobId">> {
  const { signal, cancelled, cancel, instructionInSystemPrompt } = opts;
  // Default to `either`, not `gate` (DHK-363): with `gate` the stage-complete tool is disabled, so an
  // interactive stage can only end `ok` if the human happens to type "allow"/"approve" - a keyword
  // nothing tells them about. A stage that omits `exit` must still be completable.
  const exit = ctx.config.exit ?? "either";
  const wantsTool = exit === "tool" || exit === "either";
  const { firstReplyMs, idleMs } = interactiveIdleWindows(ctx);

  // Fan the relayed human-turn stream into (a) conversational turns this loop reads and (b) a blocking
  // `ask` a session's injected structured-question tool awaits. Assemble the complete hooks (router-backed
  // `ask` included) BEFORE building the session, so the session receives its `ask` immutably at
  // construction and a question raised on the opening turn already reaches the router.
  const router = createElicitTurnRouter(turns, { signal, firstReplyMs, idleMs });
  const humanIter = router.conversation[Symbol.asyncIterator]();
  let awaitingFirstReply = true;
  const ask = async (question: ElicitQuestion): Promise<string> => {
    const outcome = await router.ask(awaitingFirstReply, () => {
      emit({ type: "elicitation", prompt: question.prompt, signal: "select", options: question.options });
      ctx.emitElicit?.(question);
    });
    return elicitOutcomeReply(outcome);
  };
  const session = makeSession({ emit, ask });

  let toolSummary: string | undefined;
  let artifact: { path: string; content: string } | undefined;
  let exited: "tool" | "gate" | "timeout" | "cancelled" = "gate";
  let pending = humanIter.next();
  try {
    // Self-seed the opening turn: an interactive stage's trigger text rides in `issueContext`, not as a
    // queued human turn, so open the interview ourselves rather than idling to a timeout.
    const seed = await session.sendTurn(interactiveSeedText(ctx, instructionInSystemPrompt));
    if (seed.stageComplete && wantsTool) {
      exited = "tool";
      toolSummary = seed.summary;
      artifact = seed.artifact;
    }
    for (;;) {
      if (exited === "tool") break; // the opening turn already completed the stage
      // The first wait is for the human's opening reply (longer budget); later waits are inter-turn
      // idles once the conversation is live.
      const race = await raceNextTurn(pending, awaitingFirstReply ? firstReplyMs : idleMs, signal);
      awaitingFirstReply = false;
      if (race.kind === "cancelled") {
        exited = "cancelled";
        break;
      }
      if (race.kind === "idle-timeout") {
        exited = "timeout";
        break;
      }
      if (race.kind === "turns-exhausted") {
        exited = "gate";
        break;
      }
      // race.kind === "turn": coalesce a burst of rapid turns into one prompt.
      const texts: string[] = [(race.value as HumanTurn).text];
      pending = humanIter.next();
      for (;;) {
        const more = await raceNextTurn(pending, COALESCE_MS, signal);
        if (more.kind === "turn") {
          texts.push((more.value as HumanTurn).text);
          pending = humanIter.next();
          continue;
        }
        if (more.kind === "cancelled") exited = "cancelled";
        break;
      }
      if (exited === "cancelled") break;
      const tr = await session.sendTurn(texts.join("\n"));
      if (tr.stageComplete && wantsTool) {
        exited = "tool";
        toolSummary = tr.summary;
        artifact = tr.artifact;
        break;
      }
    }
  } catch (e) {
    if (!cancelled()) emit({ type: "error", kind: "runtime_error", message: (e as Error).message });
    exited = cancelled() ? "cancelled" : "gate";
  }

  let status: JobStatus = "ok";
  let summary = "";
  if (exited === "tool") {
    summary = toolSummary ?? "(stage marked complete)";
  } else if (exited === "gate") {
    // Turns exhausted with no tool exit: one engine-owned summarisation turn on the warm session.
    summary = await session.summariseTurn();
  } else if (exited === "timeout") {
    status = "timeout";
    summary = "(stage timed out awaiting input)";
    await cancel();
  } else {
    status = "fail";
    summary = "(stage cancelled)";
  }

  const costUsd = session.cost();
  const sessionId = session.sessionId;
  const outArtifact = status === "ok" ? artifact : undefined;
  return {
    status,
    summary,
    ...(sessionId ? { sessionId } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(outArtifact ? { artifact: outArtifact } : {}),
  } as Omit<JobResult, "jobId">;
}

/**
 * The shared batch loop: one `sendTurn(resolveStagePrompt)`, settle the status, read `cost()`/
 * `sessionId`. A thrown `sendTurn` is the terminal-failure boundary - emit `runtime_error` (guarded by
 * the runner's `cancelled` predicate, so a cancel-driven throw is not mis-reported) and settle `fail`.
 */
export async function runBatchLoop(
  session: RuntimeSession,
  ctx: RunnerContext,
  hooks: RuntimeSessionHooks,
  opts: { cancelled: () => boolean },
): Promise<Omit<JobResult, "jobId" | "summary">> {
  let status: JobStatus = "ok";
  try {
    const tr = await session.sendTurn(resolveStagePrompt(ctx));
    if (tr.status) status = tr.status;
  } catch (e) {
    if (!opts.cancelled()) hooks.emit({ type: "error", kind: "runtime_error", message: (e as Error).message });
    status = "fail";
  }
  if (opts.cancelled()) status = "fail";
  const costUsd = session.cost();
  const sessionId = session.sessionId;
  return { status, ...(sessionId ? { sessionId } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}
