/**
 * The Pi runtime adapter: a thin wrapper over @earendil-works/pi-coding-agent's embedded
 * `AgentSession` behind the contract `Runner`. Pi is the model-agnostic runtime (the platform
 * managed node): a single runtime that attaches different provider subscriptions via brokered
 * inference creds (`runtimeEnv`). It runs a stage to a terminal result
 * (batch) or across multi-turn human input (interactive), emitting the SAME normalised trace
 * envelope the Claude and Codex adapters produce, supplies the engine-owned summary, and
 * cancels cleanly.
 *
 * No LLM call decides control flow: this is the inside of a stage. The pure event -> envelope
 * mapping lives in ./pi-mappers.ts. Modelled on the Codex adapter:
 * like Codex, Pi has no live low-latency prompt injection, so interactive turns resume one at a
 * time (each human turn is one `session.prompt()` awaited to completion).
 *
 * The live SDK is reached through a small injectable session factory (`PiSessionFactory`).
 * `createPiRunner()` defaults to the real `createAgentSession`; tests inject a scripted fake
 * session, so the adapter's orchestration is exercised without live inference or credentials
 * (mirroring how the pure mappers are unit-tested). The real SDK is loaded via a lazy dynamic
 * import so the build does not hard-depend on a live Pi install.
 */
import type { HumanTurn, JobResult, JobStatus, Runner, RunnerContext } from "@dahrk/contracts";
import { consumePiEvent, newPiBufferState, type PiEvent } from "./pi-mappers.js";
import {
  makeEmit,
  raceNextTurn,
  interactiveIdleWindows,
  resolveStagePrompt,
  interactiveSeedText,
  SUMMARISE_PROMPT,
  type EmittableEvent,
} from "./runner-shared.js";

/** Debounce window for coalescing a burst of rapid human turns into one prompt. */
const COALESCE_MS = Number(process.env.DAHRK_COALESCE_MS ?? process.env.SKAKEL_COALESCE_MS ?? 40);

/**
 * The injected stage-complete tool's name (interactive tool-exit). Pi has no MCP-server tool
 * namespacing like Claude's `mcp__dahrk__...`; it is a plain custom tool registered via
 * `defineTool`. The adapter watches `tool_execution_*` for this name to detect the exit and
 * capture the handoff summary from its `summary` argument.
 */
export const PI_STAGE_COMPLETE_TOOL = "dahrk_stage_complete";

/**
 * The subset of Pi's `AgentSession` the adapter drives. Kept local (not imported from the SDK)
 * so the adapter's orchestration is testable against a scripted fake and the build stays green
 * without a live Pi install. Authored to the vendored sdk.md.
 */
export interface PiSessionLike {
  /** Stable id for the session, used as the cross-attempt resume token (`sessionId`). */
  readonly sessionId?: string;
  /** Subscribe to streamed events; returns an unsubscribe function. */
  subscribe(listener: (event: PiEvent) => void): () => void;
  /** Send a prompt and resolve when the resulting agent run finishes. */
  prompt(text: string, options?: unknown): Promise<void>;
  /** Abort the in-flight operation. */
  abort(): Promise<void>;
  /** Release session resources. */
  dispose(): void;
  /** Live agent state; `state.tools` is replaced to deny tools for the summarise turn. */
  readonly agent?: { readonly state: { tools: unknown[] } };
}

/** Builds a fresh Pi session bound to the stage's worktree and brokered inference creds. */
export type PiSessionFactory = (ctx: RunnerContext) => Promise<PiSessionLike>;

export interface PiRunnerDeps {
  /** Override the session factory (tests inject a scripted fake). Defaults to the live SDK. */
  createSession?: PiSessionFactory;
}

export function createPiRunner(deps: PiRunnerDeps = {}): Runner {
  const createSession = deps.createSession ?? defaultCreatePiSession;
  const abortController = new AbortController();
  const signal = abortController.signal;
  let cancelled = false;
  let session: PiSessionLike | undefined;
  let sessionId: string | undefined;

  /** Open the session once and keep it warm so `summarise()` reuses the batch session. */
  const openSession = async (ctx: RunnerContext): Promise<PiSessionLike> => {
    if (!session) session = await createSession(ctx);
    return session;
  };

  const captureSessionId = (s: PiSessionLike): void => {
    if (s.sessionId) sessionId = s.sessionId;
  };

  return {
    runtime: "pi",

    async runBatch(ctx, onTrace) {
      const emit = makeEmit("pi", onTrace);
      const s = await openSession(ctx);
      const state = newPiBufferState();
      let status: JobStatus = "ok";
      const unsub = s.subscribe((ev) => {
        const rawRef = ctx.writeRaw?.(ev);
        const r = consumePiEvent(ev, state, false);
        for (const e of r.events) emit(e, rawRef);
        if (r.isResult && r.status) status = r.status;
      });
      try {
        await s.prompt(resolveStagePrompt(ctx));
      } catch (e) {
        if (!cancelled) emit({ type: "error", kind: "runtime_error", message: (e as Error).message });
        status = "fail";
      } finally {
        unsub();
      }
      captureSessionId(s);
      if (cancelled) status = "fail";
      return { status, ...(sessionId ? { sessionId } : {}) };
    },

    async runInteractive(ctx, turns, onTrace) {
      const emit = makeEmit("pi", onTrace);
      const s = await openSession(ctx);
      const state = newPiBufferState();
      // Default to `either`, not `gate` (DHK-363): with `gate` the stage-complete tool is disabled,
      // so an interactive stage can only end `ok` if the human happens to type "allow"/"approve" -
      // a keyword nothing tells them about. A stage that omits `exit` must still be completable.
      const exit = ctx.config.exit ?? "either";
      const wantsTool = exit === "tool" || exit === "either";

      let toolFired = false;
      let toolSummary: string | null = null;
      let stageCompleteCallId: string | undefined;
      let lastResponseText: string | undefined;

      // One persistent subscription across all turns. Per-turn stage-exit is suppressed (the stage
      // runner owns the single final one); the injected stage-complete tool is detected here and kept
      // out of the trace (it is control-plane, not stage work).
      const unsub = s.subscribe((ev) => {
        const rawRef = ctx.writeRaw?.(ev);
        if (ev.type === "tool_execution_start" && ev.toolName === PI_STAGE_COMPLETE_TOOL) {
          toolFired = true;
          stageCompleteCallId = ev.toolCallId;
          const args = ev.args as { summary?: string } | undefined;
          if (args?.summary) toolSummary = args.summary;
          return;
        }
        if (ev.type === "tool_execution_end" && ev.toolCallId === stageCompleteCallId) return;
        const r = consumePiEvent(ev, state, true);
        for (const e of r.events) emit(e, rawRef);
        if (r.responseText) lastResponseText = r.responseText;
      });

      const humanIter = turns[Symbol.asyncIterator]();
      const { firstReplyMs, idleMs } = interactiveIdleWindows(ctx);
      let awaitingFirstReply = true;
      let exited: "tool" | "gate" | "timeout" | "cancelled" = "gate";
      let pending = humanIter.next();
      try {
        // Self-seed the opening turn: the stage's trigger text rides in `issueContext`, not
        // as a queued human turn, so open the interview ourselves rather than idling to a timeout.
        // Pi carries no system instruction, so seed the full resolved prompt (as the batch path does).
        await s.prompt(interactiveSeedText(ctx, false));
        if (toolFired && wantsTool) exited = "tool";
        for (;;) {
          if (exited === "tool") break; // the opening turn already completed the stage
          // The first wait is for the human's opening reply (longer budget); later waits are
          // inter-turn idles once the conversation is live.
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
          await s.prompt(texts.join("\n"));
          if (toolFired && wantsTool) {
            exited = "tool";
            break;
          }
        }
      } catch (e) {
        if (!cancelled) emit({ type: "error", kind: "runtime_error", message: (e as Error).message });
        exited = cancelled ? "cancelled" : "gate";
      }

      let status: JobStatus = "ok";
      let summary = "";
      if (exited === "tool") {
        summary = toolSummary ?? "(stage marked complete)";
      } else if (exited === "gate") {
        // Turns exhausted with no tool exit: one engine-owned summarisation turn on the warm session.
        lastResponseText = undefined;
        try {
          await s.prompt(SUMMARISE_PROMPT);
          summary = (lastResponseText ?? "").trim() || "(no summary produced)";
        } catch {
          summary = "(no summary produced)";
        }
      } else if (exited === "timeout") {
        status = "timeout";
        summary = "(stage timed out awaiting input)";
        await this.cancel();
      } else {
        status = "fail";
        summary = "(stage cancelled)";
      }

      unsub();
      captureSessionId(s);
      return { status, summary, ...(sessionId ? { sessionId } : {}) } as Omit<JobResult, "jobId">;
    },

    async summarise(ctx) {
      // Engine-owned handoff turn: reuse the warm in-closure session for one constrained turn. Deny
      // tools (the model must recap what it just did, not start fresh work) and emit NO trace events
      // (the summary is an engine artefact, not the agent's stage work).
      if (!session) return "(no summary: session not established)";
      const s = session;
      if (s.agent) s.agent.state.tools = [];
      const state = newPiBufferState();
      let out: string | undefined;
      const unsub = s.subscribe((ev) => {
        const r = consumePiEvent(ev, state, true);
        if (r.responseText) out = r.responseText;
      });
      try {
        await s.prompt(SUMMARISE_PROMPT);
        captureSessionId(s);
        return (out ?? "").trim() || "(no summary produced)";
      } catch (e) {
        return `(summary unavailable: ${(e as Error).message})`;
      } finally {
        unsub();
      }
      // ctx is unused: the warm session already carries the worktree + model.
    },

    async cancel() {
      if (cancelled) return;
      cancelled = true;
      abortController.abort();
      try {
        await session?.abort();
      } catch {
        /* best effort: suppress a late abort error */
      }
      try {
        session?.dispose();
      } catch {
        /* best effort */
      }
    },
  };
}

/**
 * The live session factory: embed Pi via `createAgentSession` bound to the stage worktree, with
 * brokered inference creds applied as runtime API-key overrides (never persisted). The SDK is a pinned
 * dependency (`@earendil-works/pi-coding-agent@0.80.6`, published on npm) but is still loaded through a
 * variable-specifier dynamic import as `any` so `tsc` does not resolve its types at build time: the
 * package is loaded lazily only on the live path, so typecheck and the injected-fake tests never need
 * it resolved. This is the live path exercised end-to-end under a managed node and refined by container
 * isolation; the adapter orchestration itself is covered by tests through the injected factory.
 */
async function defaultCreatePiSession(ctx: RunnerContext): Promise<PiSessionLike> {
  const spec = "@earendil-works/pi-coding-agent";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(spec);
  const { AuthStorage, ModelRegistry, SessionManager, createAgentSession, defineTool, resolveCliModel } = mod;

  const authStorage = AuthStorage.create();
  // Brokered inference creds: the hub injects provider keys via `runtimeEnv`; apply them as
  // runtime overrides (AuthStorage's highest-priority, non-persisted source) so Pi resolves them as if
  // set by the operator and the agent never sees the raw secret. Keep the adapter hermetic: do not
  // inherit machine-global ~/.pi config. Env var -> provider mapping follows Pi's provider ids.
  for (const [key, value] of Object.entries(ctx.runtimeEnv ?? {})) {
    const provider = PROVIDER_BY_ENV[key];
    if (provider) authStorage.setRuntimeApiKey(provider, value);
  }
  const modelRegistry = ModelRegistry.create(authStorage);

  let model: unknown;
  if (ctx.config.model) {
    const resolved = resolveCliModel({ cliModel: ctx.config.model, modelRegistry });
    if (!resolved?.error) model = resolved?.model;
  }

  // The injected stage-complete tool (interactive tool-exit); harmless on batch stages.
  const stageComplete = defineTool({
    name: PI_STAGE_COMPLETE_TOOL,
    label: "Stage complete",
    description: "End the current stage and hand off a one-sentence summary of what was accomplished.",
    parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    execute: async () => ({ content: [{ type: "text", text: "Stage marked complete." }], details: {} }),
  });

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(ctx.workspace.worktreePath),
    authStorage,
    modelRegistry,
    cwd: ctx.workspace.worktreePath,
    customTools: [stageComplete],
    ...(model ? { model } : {}),
  });
  return session as PiSessionLike;
}

/** Common provider inference-key env var names -> Pi provider ids ( `runtimeEnv`). */
const PROVIDER_BY_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  GEMINI_API_KEY: "google",
  GOOGLE_API_KEY: "google",
};
