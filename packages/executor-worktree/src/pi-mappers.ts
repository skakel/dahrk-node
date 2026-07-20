/**
 * Pure Pi (`@earendil-works/pi-coding-agent`) session-event -> normalised trace envelope
 * mapping. Spike B: this de-risks the envelope mapping BEFORE the full runtime
 * adapter. It maps Pi `AgentSessionEvent`s DIRECTLY onto the SAME envelope the
 * Claude mapper produces, so a cross-runtime reader (a later stage, an `on_fail`
 * re-run, the optimiser) never sees a runtime-specific shape.
 *
 * The load-bearing difference from Claude: Pi STREAMS assistant text and reasoning as
 * `message_update` deltas rather than delivering whole messages/items, so the response cannot
 * be read off a single message. The buffered state machine below (`consumePiEvent`) accumulates
 * deltas and settles at `turn_end`/`agent_end`, applying cyrus's CYPACK-1177 rule exactly as
 * `consumeClaudeMessage` does: the response is the LAST assistant text, and NEVER the body of a
 * turn that ended on a tool call. The settling `state` (stage-exit) is emitted at the terminal
 * boundary; `suppressStageExit` drops the per-turn marker on the interactive path, mirroring the
 * Claude mapper (the stage runner owns the single final stage-exit).
 *
 * SPIKE POSTURE: the `PiEvent` shapes below are a spike-local structural SUBSET of Pi's real
 * `AgentSessionEvent` union, authored to the vendored docs (sdk.md event list; session-format.md
 * `Usage`/`ToolResultMessage`). The docs name `toolName`/`isError` on the events but do not spell
 * out the tool-call id / args field names on the *event* object; `toolCallId`/`args` here are the
 * documented `ToolCall` shape and MUST be reconciled against the real SDK types in.
 * Keeping this dependency-free (no `@earendil-works/pi-coding-agent` import) is deliberate: T6 adds
 * the dependency; this spike proves the mapping first.
 *
 * Pure: no SDK calls, no I/O.
 */
import type { JobStatus, TraceMeta } from "@dahrk/contracts";
import type { EmittableEvent } from "./runtime-session.js";
import { decideResponse } from "./response-rule.js";

/** Pi `Usage` (session-format.md): note `cacheWrite`, which we normalise to `cacheCreate`. */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The settling assistant message carried on `turn_end`/`agent_end`. */
export interface PiAssistantSummary {
  usage?: PiUsage;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
}

/** The streamed body of a `message_update`. `text_delta`/`thinking_delta` are owned by the buffered
 *  state machine (their `delta` accumulates); any other kind is recognised metadata, not normalised.
 *  A single open shape (not a discriminated union) so `.delta` access is narrowing-free. */
export interface PiAssistantMessageEvent {
  type: string;
  delta?: string;
  [k: string]: unknown;
}

/** Recognised Pi lifecycle/interim event kinds carrying no normalised payload: captured in the raw
 *  sidecar, mapped to no trace event. */
export type PiNoiseType =
  | "message_start"
  | "message_end"
  | "agent_start"
  | "turn_start"
  | "tool_execution_update"
  | "queue_update"
  | "compaction_start"
  | "compaction_end"
  | "auto_retry_start"
  | "auto_retry_end";

export type PiEvent =
  | { type: "message_update"; assistantMessageEvent: PiAssistantMessageEvent }
  | { type: "tool_execution_start"; toolName: string; toolCallId: string; args?: unknown }
  | { type: "tool_execution_end"; toolCallId: string; content?: unknown; isError?: boolean }
  | { type: "turn_end"; message?: PiAssistantSummary; toolResults?: unknown[] }
  | { type: "agent_end"; messages?: PiAssistantSummary[] }
  | { type: PiNoiseType };

/**
 * Validate an untrusted parsed-JSON value from the RPC wire as a `PiEvent`, returning `null` if it is
 * not one. The embedded SDK back-end hands the mapper real typed `AgentSessionEvent`s, but the RPC
 * back-end (`PiRpcSession`) reads arbitrary JSON off a subprocess's stdout - a `null`, a primitive, or a
 * `message_update` missing its body would otherwise be cast straight to `PiEvent` and crash the mapper
 * on first field access (`ev.type`, `ev.assistantMessageEvent.type`). This guard is the single boundary
 * where the wire becomes trusted: it pins exactly the invariants the mappers dereference unconditionally
 * - an object with a string `type`, and a `message_update` whose `assistantMessageEvent` is an object.
 * An unknown `type` passes through and is handled as noise by `mapPiEvent`'s default case; every other
 * field is already read defensively downstream.
 */
export function parsePiEvent(msg: unknown): PiEvent | null {
  if (typeof msg !== "object" || msg === null) return null;
  const type = (msg as { type?: unknown }).type;
  if (typeof type !== "string") return null;
  if (type === "message_update") {
    const ame = (msg as { assistantMessageEvent?: unknown }).assistantMessageEvent;
    if (typeof ame !== "object" || ame === null) return null;
  }
  return msg as PiEvent;
}

export interface MapResult {
  events: EmittableEvent[];
  recognised: boolean;
}

/** Pi `Usage` -> the envelope's usage shape, identical to what the Claude mapper produces.
 *  Pi's `cacheWrite` is the cache-creation counter (Claude's `cache_creation_input_tokens`). */
export function mapUsage(u?: PiUsage): TraceMeta["usage"] {
  return {
    input: u?.input ?? 0,
    output: u?.output ?? 0,
    cacheRead: u?.cacheRead ?? 0,
    cacheCreate: u?.cacheWrite ?? 0,
  };
}

/** The settle status of a `turn_end`/`agent_end`: a `stop`/`length`/`toolUse` stop reason is `ok`;
 *  an `error`/`aborted` stop reason or a surfaced `errorMessage` is `fail`. */
function settleStatus(m?: PiAssistantSummary): JobStatus {
  if (!m) return "ok";
  if (m.errorMessage || m.stopReason === "error" || m.stopReason === "aborted") return "fail";
  return "ok";
}

/** The settling assistant message for a `turn_end` (its `message`) or `agent_end` (the last of its
 *  `messages`) - the carrier of the terminal usage/stopReason. */
function settleMessage(ev: PiEvent): PiAssistantSummary | undefined {
  if (ev.type === "turn_end") return ev.message;
  if (ev.type === "agent_end") return ev.messages?.[ev.messages.length - 1];
  return undefined;
}

/**
 * Pure: one Pi event -> zero or more normalised trace events, DISCRETELY (no buffered state).
 * Assistant text and reasoning deltas are NOT turned into events here - they stream and are owned
 * by `consumePiEvent`'s buffer, exactly as `mapClaudeMessage` keeps assistant text out and lets the
 * buffered rule decide the response. Used by `consumePiEvent` for the discrete `action`/
 * `observation`/settling events, and directly by tests for the recognised/unknown checks.
 */
export function mapPiEvent(ev: PiEvent): MapResult {
  switch (ev.type) {
    case "tool_execution_start":
      return {
        events: [{ type: "action", tool: ev.toolName, toolUseId: ev.toolCallId, input: ev.args }],
        recognised: true,
      };
    case "tool_execution_end":
      return {
        events: [
          { type: "observation", toolUseId: ev.toolCallId, output: ev.content, isError: Boolean(ev.isError) },
        ],
        recognised: true,
      };
    case "turn_end":
    case "agent_end": {
      const m = settleMessage(ev);
      const status = settleStatus(m);
      const events: EmittableEvent[] = [];
      if (status !== "ok") {
        const kind = ev.type === "agent_end" ? "agent_error" : "turn_error";
        events.push({ type: "error", kind, message: m?.errorMessage ?? m?.stopReason ?? "failed" });
      }
      events.push({ type: "state", event: "stage-exit", status, usage: mapUsage(m?.usage) });
      return { events, recognised: true };
    }
    // Streamed deltas: owned by the buffered state machine, no discrete event here.
    case "message_update":
    // Lifecycle / interim noise: recognised, captured in the raw sidecar, not normalised.
    case "message_start":
    case "message_end":
    case "agent_start":
    case "turn_start":
    case "tool_execution_update":
    case "queue_update":
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
      return { events: [], recognised: true };
    default:
      return { events: [], recognised: false };
  }
}

/**
 * The Pi analogue of Claude's `BufferState`, threaded across a turn's streamed events. `bufferedText`
 * accumulates assistant `text_delta`s (the candidate response); `pendingThought` accumulates
 * `thinking_delta`s; `turnEndedOnTool` records that the turn moved on to a tool call (so the buffered
 * text is intermediate narration, not the response - the CYPACK-1177 guard).
 */
export interface PiBufferState {
  bufferedText: string;
  pendingThought: string;
  turnEndedOnTool: boolean;
}

export const newPiBufferState = (): PiBufferState => ({
  bufferedText: "",
  pendingThought: "",
  turnEndedOnTool: false,
});

/**
 * Pure: fold one Pi event into the running buffered-response state and return the ordered events to
 * emit. This is the single behavioural claim the spike de-risks - the CYPACK-1177 rule over STREAMED
 * deltas:
 *   - `text_delta` accumulates into `bufferedText` and clears `turnEndedOnTool` (a fresh text turn);
 *   - `thinking_delta` accumulates into `pendingThought`;
 *   - a tool call flushes any `pendingThought` as a `thought`, emits the `action`, marks the turn as
 *     tool-ended and discards the buffered text (text before a tool call is not the response);
 *   - at `turn_end`/`agent_end` the response is the buffered text IFF the turn did not end on a tool
 *     and the settle succeeded, then the settling `state` (stage-exit) is emitted (unless suppressed).
 *
 * Side-effect-free over `state` aside from the documented mutation, so it is unit-testable against
 * recorded fixtures with no SDK and no I/O, matching `consumeClaudeMessage`.
 */
export function consumePiEvent(
  ev: PiEvent,
  state: PiBufferState,
  suppressStageExit: boolean,
): { events: EmittableEvent[]; isResult: boolean; status?: JobStatus; responseText?: string } {
  const events: EmittableEvent[] = [];

  if (ev.type === "message_update") {
    const ame = ev.assistantMessageEvent;
    if (ame.type === "text_delta") {
      state.bufferedText += ame.delta ?? "";
      state.turnEndedOnTool = false;
    } else if (ame.type === "thinking_delta") {
      state.pendingThought += ame.delta ?? "";
    }
    // Any other assistant-message-event kind is recognised metadata, no event.
    return { events, isResult: false };
  }

  if (ev.type === "tool_execution_start") {
    if (state.pendingThought) {
      events.push({ type: "thought", subtype: "reasoning_text", text: state.pendingThought });
      state.pendingThought = "";
    }
    events.push(...mapPiEvent(ev).events);
    state.turnEndedOnTool = true;
    // Text streamed before a tool call is intermediate narration (or tool-input prose), not the
    // response - discard it so it can never surface as the terminal response.
    state.bufferedText = "";
    return { events, isResult: false };
  }

  if (ev.type === "tool_execution_end") {
    events.push(...mapPiEvent(ev).events);
    return { events, isResult: false };
  }

  if (ev.type === "turn_end" || ev.type === "agent_end") {
    const r = mapPiEvent(ev);
    const status = settleStatus(settleMessage(ev));
    // CYPACK-1177 settle decision, shared with the Claude mapper (response-rule.ts).
    const decision = decideResponse(state.bufferedText, state.turnEndedOnTool, status);
    if (decision.event) events.push(decision.event);
    // A trailing reasoning delta with no following tool/text still surfaces as a thought.
    if (state.pendingThought) {
      events.push({ type: "thought", subtype: "reasoning_text", text: state.pendingThought });
    }
    for (const e of r.events) {
      if (suppressStageExit && e.type === "state") continue;
      events.push(e);
    }
    state.bufferedText = "";
    state.pendingThought = "";
    state.turnEndedOnTool = false;
    return { events, isResult: true, status, responseText: decision.responseText };
  }

  // Recognised lifecycle noise (and unknown events) contribute nothing to the buffer.
  return { events, isResult: false };
}
