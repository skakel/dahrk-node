/**
 * The loop-facing runtime port and its contract glue. A `RuntimeSession` is the turn-level seam the
 * shared interactive/batch loops drive; each runtime (embedded Pi, container Pi, Claude) implements it
 * over its own transport, mapping its native events into `TurnResult` INSIDE the session so the loop
 * stays runtime-agnostic. This module also holds the cross-cutting glue every adapter needs regardless
 * of the loop: the trace-emit envelope stamper, the policy-aware context shape, and the engine-owned
 * summarisation prompt.
 */
import type {
  ElicitQuestion,
  JobStatus,
  PolicyOutcome,
  Runtime,
  RunnerContext,
  TraceEvent,
} from "@dahrk/contracts";

/** Distributive Omit: a plain `Omit<Union, K>` collapses to the union's common keys and
 *  drops the per-variant discriminated fields, so we distribute over each member instead. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** An envelope body the mappers produce: the stage runner's TraceWriter owns seq, and
 *  the adapter stamps ts/runtime/rawRef, so the mapper never sets them. */
export type EmittableEvent = DistributiveOmit<TraceEvent, "seq" | "ts" | "runtime" | "rawRef">;

/**
 * The stage runner puts `authorizeToolUse` on the RunnerContext for every runtime (the edge policy
 * gate) plus `emitElicit` for elicitation; neither is on the base `RunnerContext` type. Shared by both
 * runtime adapters so the policy-aware shape is defined once.
 */
export type PolicyAwareRunnerContext = RunnerContext & {
  authorizeToolUse?: (toolName: string, input: unknown) => PolicyOutcome;
  /** Surface an interactive-stage structured question as a Linear `select` elicitation (DHK-344).
   *  Supplied by the stage runner; absent in tests that do not exercise the elicit path. */
  emitElicit?: (question: ElicitQuestion) => void;
};

/**
 * The engine-owned summarisation prompt (build spec section 9): one constrained turn that
 * produces the stage's user-facing recap. It is read by a human in Linear (as a response
 * activity and folded into the whole-run recap comment), NOT fed to the next stage, so it is
 * written for the reviewer, not for handoff. Reused by both the batch `summarise()` method and
 * the interactive gate-exit path.
 */
export const SUMMARISE_PROMPT =
  "This stage is ending. In ONE concise sentence for a human reviewer reading the Linear ticket, " +
  "state concretely what you DID or FOUND in this stage and the result (for example which " +
  "functions or files changed, whether the tests pass, or what a review flagged). Be specific and " +
  "lead with the outcome. Do not mention internal scratch files or a next-stage entry point. Reply " +
  "with only that sentence.";

/**
 * Build the per-event emit function an adapter calls for each mapped event. It stamps
 * `ts`/`runtime` (and `rawRef` when the source record was persisted), leaves `seq: 0`
 * for the TraceWriter to overwrite in append order, then forwards to `onTrace`.
 */
export function makeEmit(
  runtime: Runtime,
  onTrace: (event: TraceEvent) => void,
  now: () => string = () => new Date().toISOString(),
): (event: EmittableEvent, rawRef?: string) => void {
  return (event, rawRef) => {
    const full: Record<string, unknown> = { ...event, seq: 0, ts: now(), runtime };
    if (rawRef !== undefined) full.rawRef = rawRef;
    onTrace(full as unknown as TraceEvent);
  };
}

/**
 * The normalised outcome of one turn, as the shared loop reads it. A `RuntimeSession` maps its own
 * native events (Pi `PiEvent`, later Claude `SDKMessage`) into this shape INSIDE the session, so the
 * loop never sees a runtime-specific record. `stageComplete` is the injected stage-complete exit tool
 * firing this turn; `summary` its handoff text; `responseText` the last assistant text (used for the
 * gate recap by runtimes that read it off a turn); `status` the settle status; `artifact` a document
 * handed back in-band (Claude uses it; Pi omits it).
 */
export type TurnResult = {
  stageComplete: boolean;
  summary?: string;
  responseText?: string;
  status?: JobStatus;
  artifact?: { path: string; content: string };
};

/**
 * The loop-facing runtime port: a turn-level seam the shared interactive/batch loops drive. Each
 * runtime (embedded Pi, container Pi, later Claude) implements it over its own transport, keeping the
 * native-event mapping and stage-complete detection INSIDE the session. Deliberately free of any
 * `PiEvent`/`SDKMessage` reference so the one loop is runtime-agnostic.
 */
export interface RuntimeSession {
  /** Stable id used as the cross-attempt resume token; absent until the runtime assigns one. */
  readonly sessionId?: string;
  /** Send one prompt, run it to the turn's terminus, emit its trace via the hooks, return the outcome.
   *  Must NOT swallow an underlying throw: the loop owns the terminal `runtime_error`/`fail` decision. */
  sendTurn(text: string): Promise<TurnResult>;
  /** The engine-owned handoff turn: deny tools, run `SUMMARISE_PROMPT`, return the recap sentence. Emits
   *  no trace (it is an engine artefact, not the agent's stage work). */
  summariseTurn(): Promise<string>;
  /** The stage's aggregate dollar cost, or `undefined` when the run cannot be priced (never a `0`). */
  cost(): number | undefined;
  /** Release the session's resources. */
  dispose(): void;
}

/**
 * The side-channels a `RuntimeSession` needs from the loop, held once per stage: `emit` is the trace
 * sink (the per-event `makeEmit` closure) and `ask` surfaces an interactive-stage structured question
 * as a Linear elicitation through the shared router. Both are final when the session is built: the
 * interactive loop assembles the router-backed `ask` and passes the complete hooks to the
 * `RuntimeSessionFactory`, so `ask` is never reassigned after construction. (Batch has no elicitation
 * and passes a `noreply` default.)
 */
export interface RuntimeSessionHooks {
  emit: (event: EmittableEvent, rawRef?: string) => void;
  ask: (question: ElicitQuestion) => Promise<string>;
}

/** Build a `RuntimeSession` bound to a complete `hooks`. The interactive loop calls this AFTER it has
 *  assembled the final hooks (real `emit` + router-backed `ask`), so the session receives its `ask`
 *  immutably at construction - no post-construction reassignment. The adapter captures the stage `ctx`
 *  and its already-open transport in the closure. */
export type RuntimeSessionFactory = (hooks: RuntimeSessionHooks) => RuntimeSession;
