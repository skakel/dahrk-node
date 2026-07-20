/**
 * The CYPACK-1177 buffered-response rule - the single behavioural claim shared by both trace mappers:
 * at a turn's terminal boundary the response is the LAST assistant text, and NEVER the body of a turn
 * that ended on a tool call (that text is intermediate narration or tool-input prose).
 *
 * The two mappers accumulate the candidate text differently and deliberately do NOT share that: Claude
 * delivers whole assistant messages so `consumeClaudeMessage` replaces the buffer per message, while Pi
 * streams `text_delta`s so `consumePiEvent` appends them. Forcing one accumulator would be a false
 * abstraction. But the SETTLE decision is identical, so it lives here - one home for the rule, so a
 * change to what counts as a response (or a new veto) touches one function, not two mappers that must
 * stay in lock-step.
 */
import type { JobStatus } from "@dahrk/contracts";
import type { EmittableEvent } from "./runtime-session.js";

/** The settled turn's response, or an empty decision when no response is posted. */
export interface ResponseDecision {
  /** The chosen response text; `undefined` when a veto fired. */
  responseText?: string;
  /** The `response` trace event to emit, present exactly when `responseText` is. */
  event?: EmittableEvent;
}

/**
 * Decide a turn's response from its settled buffer. Any of three vetoes yields no response: a non-`ok`
 * settle status, empty/whitespace-only text, or a turn that ended on a tool call. The text is trimmed
 * (Claude trims on capture, Pi accumulates raw deltas; trimming here settles both identically).
 */
export function decideResponse(bufferedText: string, endedOnTool: boolean, status: JobStatus): ResponseDecision {
  const text = bufferedText.trim();
  if (status !== "ok" || !text || endedOnTool) return {};
  return { responseText: text, event: { type: "response", text } };
}
