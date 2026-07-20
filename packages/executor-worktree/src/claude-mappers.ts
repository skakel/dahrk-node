/**
 * Pure Claude Agent SDK message -> normalised trace envelope mapping. Ported verbatim
 * from the S3 spike (spikes/s3-trace-mapping/src/claude-adapter.ts), which models cyrus's
 * SDK-to-activity mapping (read as reference, not depended on):
 *   - the recognised message set (assistant / user / result + recognised-but-not-normalised
 *     control metadata); anything else is "unknown" and captured only in the raw sidecar;
 *   - tool_use -> action emitted immediately; tool_result -> observation;
 *   - the response is the LAST assistant text, decided at `result` time with cyrus's
 *     CYPACK-1177 guard - the guard itself lives in the adapter's streaming loop, not here.
 *
 * This module is pure (no SDK calls, no I/O) so it can be unit-tested against recorded
 * fixtures with no credentials.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { JobStatus, TraceMeta } from "@dahrk/contracts";
import type { EmittableEvent } from "./runtime-session.js";
import { decideResponse } from "./response-rule.js";

export interface MapResult {
  events: EmittableEvent[];
  recognised: boolean;
  /** Concatenated assistant text (buffered by the caller to decide the response). */
  assistantText?: string;
  /** True when the assistant message contained a tool call (CYPACK-1177 guard). */
  hasToolUse?: boolean;
  resultStatus?: "ok" | "fail";
}

type AnyBlock = { type: string; [k: string]: unknown };

/**
 * Pure: one Claude SDK message -> trace events, plus (for assistant messages) the
 * text content and a tool-use flag so the caller can apply cyrus's buffered-
 * response rule. Assistant TEXT is not turned into an event here; thoughts/actions
 * are. The response is decided at `result` time.
 */
export function mapClaudeMessage(msg: SDKMessage): MapResult {
  switch (msg.type) {
    case "assistant": {
      const events: EmittableEvent[] = [];
      const blocks = (Array.isArray(msg.message.content) ? msg.message.content : []) as unknown as AnyBlock[];
      let text = "";
      let hasToolUse = false;
      for (const b of blocks) {
        if (b.type === "text") text += String(b.text ?? "");
        else if (b.type === "thinking")
          events.push({ type: "thought", subtype: "reasoning_text", text: String(b.thinking ?? "") });
        else if (b.type === "redacted_thinking")
          events.push({ type: "thought", subtype: "reasoning_text", text: "[redacted]" });
        else if (b.type === "tool_use") {
          hasToolUse = true;
          events.push({ type: "action", tool: String(b.name), toolUseId: String(b.id), input: b.input });
        }
      }
      const err = (msg as { error?: { message?: string } }).error;
      if (err) events.push({ type: "error", kind: "assistant_error", message: String(err.message ?? err) });
      return { events, recognised: true, assistantText: text, hasToolUse };
    }
    case "user": {
      const events: EmittableEvent[] = [];
      const content = msg.message.content;
      const blocks = (Array.isArray(content) ? content : []) as unknown as AnyBlock[];
      for (const b of blocks) {
        if (b.type === "tool_result") {
          events.push({
            type: "observation",
            toolUseId: String(b.tool_use_id),
            output: b.content,
            isError: Boolean(b.is_error),
          });
        }
      }
      return { events, recognised: true };
    }
    case "result": {
      const m = msg as unknown as {
        subtype: string;
        usage?: Record<string, number>;
        total_cost_usd?: number;
        duration_ms?: number;
      };
      const status = m.subtype === "success" ? "ok" : "fail";
      const events: EmittableEvent[] = [
        {
          type: "state",
          event: "stage-exit",
          status,
          usage: mapUsage(m.usage),
          costUsd: m.total_cost_usd,
          durationMs: m.duration_ms,
        },
      ];
      if (status !== "ok") events.push({ type: "error", kind: "result_error", message: m.subtype });
      return { events, recognised: true, resultStatus: status };
    }
    // Control / metadata: recognised, captured in the raw sidecar, not normalised.
    case "system":
    case "stream_event":
    case "rate_limit_event":
      return { events: [], recognised: true };
    default:
      return { events: [], recognised: false };
  }
}

export function mapUsage(u?: Record<string, number>): TraceMeta["usage"] {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheCreate: u?.cache_creation_input_tokens ?? 0,
  };
}

/** The CYPACK-1177 buffered-response state, threaded across a turn's messages. */
export interface BufferState {
  bufferedText: string | null;
  turnEndedOnTool: boolean;
}

export const newBufferState = (): BufferState => ({ bufferedText: null, turnEndedOnTool: false });

/**
 * Pure: fold one SDK message into the running buffered-response state and return the
 * ordered events to emit. It accumulates Claude's per-message assistant text, then at `result` time
 * applies the CYPACK-1177 rule via the shared `decideResponse` (response-rule.ts) - the response is the
 * last assistant text and NEVER the body of a turn that ended on a tool call (which is tool-input JSON).
 * `suppressStageExit` drops the per-turn `stage-exit` state event for interactive turns (the stage
 * runner owns the single final stage-exit).
 *
 * Side-effect-free over `state` aside from the documented mutation, so it is unit-testable
 * against recorded fixtures with no SDK and no I/O.
 */
export function consumeClaudeMessage(
  msg: SDKMessage,
  state: BufferState,
  suppressStageExit: boolean,
): { events: EmittableEvent[]; isResult: boolean; status?: JobStatus; responseText?: string } {
  const r = mapClaudeMessage(msg);
  const events: EmittableEvent[] = [];

  if (msg.type === "assistant") {
    events.push(...r.events);
    const text = (r.assistantText ?? "").trim();
    if (text) {
      // A new real text turn: flush the previous buffered text as a thought.
      if (state.bufferedText) events.push({ type: "thought", text: state.bufferedText });
      state.bufferedText = text;
      state.turnEndedOnTool = false;
    } else if (r.hasToolUse) {
      // Turn moved on to a tool call with no trailing text.
      if (state.bufferedText) {
        events.push({ type: "thought", text: state.bufferedText });
        state.bufferedText = null;
      }
      state.turnEndedOnTool = true;
    }
    return { events, isResult: false };
  }

  if (msg.type === "result") {
    const status: JobStatus = r.resultStatus === "fail" ? "fail" : "ok";
    // CYPACK-1177 settle decision, shared with the Pi mapper (response-rule.ts).
    const decision = decideResponse(state.bufferedText ?? "", state.turnEndedOnTool, status);
    if (decision.event) events.push(decision.event);
    for (const e of r.events) {
      if (suppressStageExit && e.type === "state") continue;
      events.push(e);
    }
    state.bufferedText = null;
    state.turnEndedOnTool = false;
    return { events, isResult: true, status, responseText: decision.responseText };
  }

  // user (observations) and recognised metadata.
  events.push(...r.events);
  return { events, isResult: false };
}
