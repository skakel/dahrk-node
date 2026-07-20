/**
 * Stage-prompt assembly: the single place both runtime adapters (and the batch and interactive paths)
 * turn a stage's config plus the run's Linear context into the text sent to the model. Resolves the
 * bare instruction (prompt_file / inline / skill / default), then folds in the ticket brief, the
 * workspace/team guidance, any gate feedback, and attached documents as delimited, defanged blocks.
 * Runtime-agnostic and side-effect-free apart from reading a configured prompt file off the worktree.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerContext } from "@dahrk/contracts";
import { attachedDocBasename } from "@dahrk/contracts";

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
  return text.replace(/<\/(documents?)>/gi, "<​/$1>");
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
  return text.replace(/<\/(guidance(?:-rule)?)>/gi, "<​/$1>");
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
