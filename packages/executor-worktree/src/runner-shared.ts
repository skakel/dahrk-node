/**
 * Shared scaffolding for the real runner adapters (Claude, Codex). None of this is
 * runtime-specific: it bridges the pure mappers (which emit envelope bodies) to the
 * stage runner's `onTrace`, supplies the engine-owned summarisation prompt, and the
 * streaming-prompt + idle-race primitives the interactive loop needs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HumanTurn, Runtime, RunnerContext, TraceEvent } from "@dahrk/contracts";
import { attachedDocBasename } from "@dahrk/contracts";

/** Distributive Omit: a plain `Omit<Union, K>` collapses to the union's common keys and
 *  drops the per-variant discriminated fields, so we distribute over each member instead. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** An envelope body the mappers produce: the stage runner's TraceWriter owns seq, and
 *  the adapter stamps ts/runtime/rawRef, so the mapper never sets them. */
export type EmittableEvent = DistributiveOmit<TraceEvent, "seq" | "ts" | "runtime" | "rawRef">;

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
 * prompt (Claude, when `hasSystemPrompt(ctx)`) so a short kickoff suffices; otherwise (Codex, Pi, or a
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
