/**
 * Shared scaffolding for the real runner adapters (Claude, Pi). None of this is
 * runtime-specific: it bridges the pure mappers (which emit envelope bodies) to the
 * stage runner's `onTrace`, supplies the engine-owned summarisation prompt, and the
 * streaming-prompt + idle-race primitives the interactive loop needs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ElicitQuestion,
  HumanTurn,
  JobResult,
  JobStatus,
  PolicyOutcome,
  Runtime,
  RunnerContext,
  TraceEvent,
} from "@dahrk/contracts";
import { attachedDocBasename } from "@dahrk/contracts";

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

/** Strip a leading YAML frontmatter block (`---` ... `---`) from a prompt-file body, so a
 *  reused `.claude/commands/*.md` file's metadata header is not sent to the model as instruction. */
function stripFrontmatter(text: string): string {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      return lines
        .slice(i + 1)
        .join("\n")
        .replace(/^\n+/, "");
    }
  }
  return text; // no closing fence: treat the whole file as body
}

/** The stage's bare instruction, before any ticket context is folded in. Precedence:
 *  prompt_file (read from the worktree) -> inline prompt -> skill -> the default. */
function stageInstruction(ctx: RunnerContext): string {
  const { config, workspace } = ctx;
  if (config.promptFile) {
    try {
      const raw = readFileSync(join(workspace.worktreePath, config.promptFile), "utf8");
      const body = stripFrontmatter(raw).trim();
      if (body) return body;
    } catch (e) {
      // Surface a usable instruction rather than silently running an empty prompt.
      return `The configured prompt file "${config.promptFile}" could not be read (${(e as Error).message}).`;
    }
  }
  if (config.prompt) return config.prompt;
  if (config.skill) return `Use the ${config.skill} skill to complete this stage.`;
  return "Begin the stage.";
}

/** Per-document inline cap. The full body is on disk at `.dahrk/scratch/docs/<slug>.md`, so the
 *  prompt only needs enough to orient the agent; a long doc is truncated with a pointer to the file. */
export const MAX_INLINE_DOC_CHARS = 6000;
/** Overall inline budget across all documents, so many attached docs cannot blow up the prompt. */
export const MAX_INLINE_DOCS_TOTAL_CHARS = 20000;

/** Defang the `<documents>`/`<document>` closing tags inside untrusted document text by inserting a
 *  zero-width space, so the text cannot close the block early and inject top-level instructions. The
 *  inserted character is invisible to a reader and does not change the meaning of the document. */
function neutraliseDelimiters(text: string): string {
  return text.replace(/<\/(documents?)>/gi, "<\u200b/$1>");
}

/** Build the `<documents>` block from the run's attached Linear documents: per doc a header (title +
 *  the scratch path holding the full text) and a capped excerpt. Returns "" when there are none.
 *  The full body always lives at `.dahrk/scratch/docs/<slug>.md`, which the edge wrote. */
function documentsBlock(ctx: RunnerContext): string {
  const docs = ctx.attachedDocuments;
  if (!docs || docs.length === 0) return "";
  let budget = MAX_INLINE_DOCS_TOTAL_CHARS;
  const parts: string[] = [];
  for (const doc of docs) {
    // Share the basename function with the edge's file write so the pointer can never drift from the
    // file it names.
    const path = `.dahrk/scratch/docs/${attachedDocBasename(doc)}.md`;
    const cap = Math.max(0, Math.min(MAX_INLINE_DOC_CHARS, budget));
    const body = doc.content.trim();
    const truncated = body.length > cap;
    const excerpt = truncated ? body.slice(0, cap) : body;
    budget -= excerpt.length;
    const tail = truncated
      ? `\n...(truncated; full text at ${path})`
      : "";
    // Title and body are untrusted (anyone who can attach a doc to the issue controls them). Neutralise
    // the block's own delimiters so a body/title containing `</document>` cannot break out of the block
    // and have its following text read as top-level prompt instructions. XML tags are not a security
    // boundary for an LLM, but this removes the trivial breakout.
    const title = doc.title.replace(/[<>"]/g, "'");
    parts.push(
      `<document title="${title}" file="${path}">\n${neutraliseDelimiters(excerpt)}${tail}\n</document>`,
    );
    if (budget <= 0) break;
  }
  return `<documents>\n${parts.join("\n\n")}\n</documents>`;
}

/** Defang the `<guidance>`/`<guidance-rule>` closing tags inside guidance text by inserting a
 *  zero-width space, mirroring `neutraliseDelimiters` for documents, so the text cannot close the block
 *  early. Guidance is operator-authored (lower risk than documents) but we stay consistent. */
function neutraliseGuidanceDelimiters(text: string): string {
  return text.replace(/<\/(guidance(?:-rule)?)>/gi, "<\u200b/$1>");
}

/** Build the `<guidance>` block from the run's Linear workspace/team guidance: one
 *  `<guidance-rule origin="..." team="...">text</guidance-rule>` per rule. Returns "" when none. */
function guidanceBlock(ctx: RunnerContext): string {
  const guidance = ctx.guidance;
  if (!guidance || guidance.length === 0) return "";
  const parts: string[] = [];
  for (const rule of guidance) {
    const content = rule.content.trim();
    if (!content) continue;
    const origin = rule.origin.replace(/[<>"]/g, "'");
    const team = rule.teamName !== undefined ? ` team="${rule.teamName.replace(/[<>"]/g, "'")}"` : "";
    parts.push(`<guidance-rule origin="${origin}"${team}>\n${neutraliseGuidanceDelimiters(content)}\n</guidance-rule>`);
  }
  if (parts.length === 0) return "";
  return `<guidance>\n${parts.join("\n")}\n</guidance>`;
}

/** Defang the `<gate-feedback>`/`<gate-note>` closing tags inside untrusted gate-feedback prose
 *  by inserting a zero-width space, mirroring the documents/guidance neutralisers, so the text cannot
 *  close its block early and inject top-level instructions. */
function neutraliseGateFeedbackDelimiters(text: string): string {
  return text.replace(/<\/(gate-feedback|gate-note)>/gi, "<​/$1>");
}

/** Build the `<gate-feedback>` block from the run's feedback-bearing gate approvals: one
 *  `<gate-note stage="..." decision="...">prose</gate-note>` per note. The prose is untrusted human
 *  input (it came in over a Linear reply), so the closing tags are defanged exactly as documents and
 *  guidance are. Returns "" when there are none. */
function gateFeedbackBlock(ctx: RunnerContext): string {
  const notes = ctx.gateFeedback;
  if (!notes || notes.length === 0) return "";
  const parts: string[] = [];
  for (const note of notes) {
    const content = note.feedback.trim();
    if (!content) continue;
    const stage = note.stageId.replace(/[<>"]/g, "'");
    const decision = note.decision.replace(/[<>"]/g, "'");
    parts.push(
      `<gate-note stage="${stage}" decision="${decision}">\n${neutraliseGateFeedbackDelimiters(content)}\n</gate-note>`,
    );
  }
  if (parts.length === 0) return "";
  return `<gate-feedback>\n${parts.join("\n")}\n</gate-feedback>`;
}

/**
 * Resolve the prompt an adapter sends for a stage: the stage instruction (from a `prompt_file`,
 * inline `prompt`, `skill`, or the default), with the run's Linear ticket brief prepended as a
 * delimited `<ticket>` block, the run's workspace/team guidance as a `<guidance>` block, and any
 * attached Linear documents as a `<documents>` block when present. This is the single place both
 * adapters (and the batch and interactive paths) build the stage prompt, so the ticket, guidance, and
 * documents reach the agent uniformly.
 */
export function resolveStagePrompt(ctx: RunnerContext): string {
  const instruction = stageInstruction(ctx);
  const ticket = ctx.issueContext?.trim()
    ? `<ticket>\n${ctx.issueContext.trim()}\n</ticket>`
    : "";
  const guidance = guidanceBlock(ctx);
  const gateFeedback = gateFeedbackBlock(ctx);
  const docs = documentsBlock(ctx);
  // Guidance sits right after the ticket (workspace direction); gate feedback follows it (run-specific
  // approving-with-guidance), both ahead of any attached documents.
  const preamble = [ticket, guidance, gateFeedback, docs].filter(Boolean).join("\n\n");
  return preamble ? `${preamble}\n\n${instruction}` : instruction;
}

/** Whether a stage carries an explicit instruction, ticket context, or attached documents worth
 *  setting as the Claude interactive `systemPrompt` (a bare `skill` did not set one before, so it is
 *  excluded here). */
export function hasSystemPrompt(ctx: RunnerContext): boolean {
  return Boolean(
    ctx.config.prompt ||
      ctx.config.promptFile ||
      ctx.issueContext?.trim() ||
      (ctx.guidance && ctx.guidance.length > 0) ||
      (ctx.gateFeedback && ctx.gateFeedback.length > 0) ||
      (ctx.attachedDocuments && ctx.attachedDocuments.length > 0),
  );
}

/**
 * A short nudge that opens an interactive stage whose instruction and ticket context already ride
 * in the runtime's system prompt (the Claude interactive path appends `resolveStagePrompt`). The
 * ticket is in context, so this just tells the agent to speak first.
 */
export const OPENING_KICKOFF =
  "Begin now. Using the ticket context and your instructions already provided, ask the human your " +
  "first question. Do not wait for further input before sending your first message.";

/**
 * The opening user turn that self-starts an interactive stage. An interactive stage is
 * triggered by a Linear label or mention whose text rides in `issueContext`, never as a queued human
 * turn, so without a seed the runner would idle until it timed out with the model never running. Pass
 * `instructionInSystemPrompt: true` when the adapter already carries the stage instruction as a system
 * prompt (Claude, when `hasSystemPrompt(ctx)`) so a short kickoff suffices; otherwise (Pi, or a
 * bare-skill Claude stage) seed the full resolved prompt so the agent has its instructions.
 */
export function interactiveSeedText(ctx: RunnerContext, instructionInSystemPrompt: boolean): string {
  return instructionInSystemPrompt ? OPENING_KICKOFF : resolveStagePrompt(ctx);
}

/**
 * A minimal push/close async queue used as the Claude streaming prompt. Human turns are
 * pushed in; the SDK's `query()` consumes it as an AsyncIterable. Ported from the S2 spike.
 */
export class ManagedMailbox<T> implements AsyncIterable<T> {
  private readonly q: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T): void {
    const w = this.waiters.shift();
    if (w) w({ value, done: false });
    else this.q.push(value);
  }

  end(): void {
    this.done = true;
    let w: ((r: IteratorResult<T>) => void) | undefined;
    while ((w = this.waiters.shift())) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const v = this.q.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

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

/** The outcome of surfacing an interactive-stage elicitation (DHK-344) and awaiting the human's turn:
 *  a `reply` carrying the selected value, `noreply` on the idle deadline, `cancel` on abort or the
 *  turn stream ending, or `busy` when an elicit is already outstanding (one at a time). */
export type ElicitOutcome =
  | { kind: "reply"; text: string }
  | { kind: "noreply" }
  | { kind: "cancel" }
  | { kind: "busy" };

/** Map an elicit outcome to the exact tool-result text the model reads. Shared so both adapters
 *  (and the Pi no-handler fallback) return byte-identical strings. */
export function elicitOutcomeReply(outcome: ElicitOutcome): string {
  switch (outcome.kind) {
    case "reply":
      return `The user selected: ${outcome.text}`;
    case "busy":
      return "Only one question can be asked at a time; wait for the current one to be answered, then ask again.";
    case "noreply":
      return "No response from the user; proceed with your best judgement.";
    case "cancel":
      return "The question was cancelled.";
  }
}

/**
 * Fan a single relayed human-turn stream out into (a) conversational turns the interactive loop reads
 * and (b) a blocking `ask` an injected `AskUserQuestion` shadow tool awaits (DHK-344). One dispatcher
 * is the sole consumer of `turns`, so the reply to an in-stage question never contends with the
 * interactive loop's own next()-waiter while the SDK is parked inside the tool. Runtime-agnostic and
 * SDK-free, so it is unit-testable without invoking a model.
 */
export interface ElicitTurnRouter {
  /** Conversational turns: every relayed turn NOT consumed by an in-flight elicit. The interactive
   *  loop reads this in place of the raw turn stream; it ends when the underlying stream ends. */
  readonly conversation: AsyncIterable<HumanTurn>;
  /**
   * Surface an elicitation and block until the next relayed turn (reply), the idle deadline
   * (noreply), or abort / stream-end (cancel). Only one elicit may be in flight; a concurrent call
   * returns `busy` immediately without calling `onRaise`. `firstReply` selects the longer
   * opening-reply budget over the inter-turn idle window. `onRaise` fires synchronously once the
   * elicit is registered (not busy), so the caller emits its trace + wire frame exactly when the
   * question is actually raised.
   */
  ask(firstReply: boolean, onRaise: () => void): Promise<ElicitOutcome>;
}

export function createElicitTurnRouter(
  turns: AsyncIterable<HumanTurn>,
  opts: { signal: AbortSignal; firstReplyMs: number; idleMs: number },
): ElicitTurnRouter {
  const conversation = new ManagedMailbox<HumanTurn>();
  // Held on an object so a read in the dispatcher closure keeps the declared type: a bare `let`
  // reassigned only inside `ask` would be narrowed to `null` by control-flow analysis.
  const ref: { settle: ((o: ElicitOutcome) => void) | null } = { settle: null };
  void (async () => {
    try {
      for await (const t of turns) {
        const settle = ref.settle;
        if (settle) settle({ kind: "reply", text: t.text });
        else conversation.push(t);
      }
    } finally {
      conversation.end();
      const settle = ref.settle;
      if (settle) settle({ kind: "cancel" });
    }
  })();
  const ask = (firstReply: boolean, onRaise: () => void): Promise<ElicitOutcome> => {
    if (ref.settle) return Promise.resolve<ElicitOutcome>({ kind: "busy" });
    onRaise();
    return new Promise<ElicitOutcome>((resolve) => {
      let settled = false;
      const finish = (o: ElicitOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
        ref.settle = null;
        resolve(o);
      };
      const onAbort = (): void => finish({ kind: "cancel" });
      const timer = setTimeout(() => finish({ kind: "noreply" }), firstReply ? opts.firstReplyMs : opts.idleMs);
      if (opts.signal.aborted) {
        finish({ kind: "cancel" });
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
      ref.settle = finish;
    });
  };
  return { conversation, ask };
}

/**
 * Debounce window (ms) for coalescing a burst of rapid human turns into one prompt. Shared by the
 * interactive loop below so both Pi back-ends debounce identically. (Claude keeps its own copy this
 * ticket; it migrates onto the shared loop in DHK-594.)
 */
export const COALESCE_MS = Number(process.env.DAHRK_COALESCE_MS ?? process.env.SKAKEL_COALESCE_MS ?? 40);

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
 * as a Linear elicitation through the shared router. The loop populates `ask` from the router before
 * the opening turn, so a session that raises a question mid-turn reaches it by stable reference.
 */
export interface RuntimeSessionHooks {
  emit: (event: EmittableEvent, rawRef?: string) => void;
  ask: (question: ElicitQuestion) => Promise<string>;
}

/** Build a `RuntimeSession` bound to the stage's context and hooks. Injected so a fake can drive the
 *  loop without a live runtime. */
export type RuntimeSessionFactory = (ctx: RunnerContext, hooks: RuntimeSessionHooks) => Promise<RuntimeSession>;

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
  session: RuntimeSession,
  ctx: RunnerContext,
  turns: AsyncIterable<HumanTurn>,
  hooks: RuntimeSessionHooks,
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
  // `ask` a session's injected structured-question tool awaits. Populate `hooks.ask` before the seed so
  // a question raised on the opening turn reaches the router.
  const router = createElicitTurnRouter(turns, { signal, firstReplyMs, idleMs });
  const humanIter = router.conversation[Symbol.asyncIterator]();
  let awaitingFirstReply = true;
  const elicitCtx = ctx as PolicyAwareRunnerContext;
  hooks.ask = async (question: ElicitQuestion): Promise<string> => {
    const outcome = await router.ask(awaitingFirstReply, () => {
      hooks.emit({ type: "elicitation", prompt: question.prompt, signal: "select", options: question.options });
      elicitCtx.emitElicit?.(question);
    });
    return elicitOutcomeReply(outcome);
  };

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
    if (!cancelled()) hooks.emit({ type: "error", kind: "runtime_error", message: (e as Error).message });
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
