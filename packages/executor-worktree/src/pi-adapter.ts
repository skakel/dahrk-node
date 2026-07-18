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
import { join } from "node:path";
import type { ElicitQuestion, HumanTurn, JobResult, JobStatus, PolicyOutcome, Runner, RunnerContext } from "@dahrk/contracts";
import { consumePiEvent, newPiBufferState, type PiEvent } from "./pi-mappers.js";
import {
  readAuthHint,
  applyApiKeyAuth,
  createStageConfigDir,
  cleanupStageConfigDir,
  writeStageAuthFile,
  writeStageCustomProviders,
} from "./pi-auth.js";
import {
  makeEmit,
  raceNextTurn,
  interactiveIdleWindows,
  resolveStagePrompt,
  interactiveSeedText,
  createElicitTurnRouter,
  SUMMARISE_PROMPT,
  type EmittableEvent,
} from "./runner-shared.js";
import { askQuestionsSequentially } from "./ask-user-question-tool.js";

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
 * The injected structured-question tool's name (DHK-505). Pi has no built-in `AskUserQuestion`
 * (the Claude Agent SDK's), so an interactive Pi stage raises a structured multiple-choice question
 * by calling this plain custom tool (registered via `defineTool`); its `execute` routes through the
 * adapter's dispatcher to a Linear elicitation and returns the human's pick as the tool result.
 */
export const PI_ASK_USER_QUESTION_TOOL = "ask_user_question";

/** A batch of structured questions as the `ask_user_question` tool presents them: each carries a
 *  prompt, labelled options (with optional descriptions), and an optional multi-select flag. Shared
 *  by the adapter's dispatcher hook and the live tool's parameter shape. */
export type AskUserQuestions = {
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}[];

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
  /**
   * Aggregate stats over ALL session entries. Pi computes the dollar figure actually billed
   * (`SessionStats.cost`), so the adapter reports it as the stage's `costUsd` rather than the
   * silent `$0` that leaves the hub's `cost_budget` policy inert (DHK-434). Optional: a minimal
   * or older session may omit it, in which case no cost is reported (never a fabricated `0`).
   */
  getSessionStats?(): { cost?: number } | undefined;
  /** Live agent state; `state.tools` is replaced to deny tools for the summarise turn. */
  readonly agent?: { readonly state: { tools: unknown[] } };
  /**
   * Register the adapter's structured-question dispatcher (DHK-505) so the live session's injected
   * `ask_user_question` tool can route a mid-stage multiple-choice question through the shared elicit
   * machinery to a Linear elicitation and hand the human's pick back as its tool result. The adapter
   * sets it at the top of `runInteractive`, once the elicit router exists. Optional: a batch-only or
   * container/RPC session that does not (yet) surface elicitation omits it, so this hook can be added
   * without changing the `PiSessionFactory` signature.
   */
  setAskUserQuestionHandler?(handler: (questions: AskUserQuestions) => Promise<string>): void;
  /**
   * Register the adapter's pre-execution tool gate (DHK-504) so the live session's `tool_call`
   * extension hook can veto a policy-violating tool call BEFORE it runs, the direct analogue of the
   * Claude adapter's `canUseTool`. The gate returns `{ block: true, reason }` to deny (Pi does not run
   * the tool and surfaces the reason) or `undefined` to allow. The adapter sets it once, right after
   * `openSession`, routing through `ctx.authorizeToolUse` so denials flow through the edge policy's
   * existing `recordDeny` path exactly as for Claude. Optional: a batch-only or older session that does
   * not surface the hook omits it, so the gate can be added without changing the `PiSessionFactory`
   * signature (mirrors `setAskUserQuestionHandler`).
   */
  setToolCallGate?(gate: (toolName: string, input: unknown) => { block?: boolean; reason?: string } | undefined): void;
}

/**
 * The stage runner puts `authorizeToolUse` on the RunnerContext for every runtime (the edge policy
 * gate) plus `emitElicit` for elicitation; neither is on the base `RunnerContext` type. Mirrors the
 * Claude adapter's `PolicyAwareRunnerContext`.
 */
export type PolicyAwareRunnerContext = RunnerContext & {
  authorizeToolUse?: (toolName: string, input: unknown) => PolicyOutcome;
  emitElicit?: (question: ElicitQuestion) => void;
};

/**
 * The pure pre-execution decision (DHK-504), the Pi analogue of the Claude adapter's
 * `policyCanUseTool`. Consult the edge policy: only a `deny` verdict blocks the call, carrying the
 * policy's `reason` (falling back to the policy name, exactly as Claude does). `ask`/`allow`/an absent
 * `authorizeToolUse` all pass through as `undefined` (allow) - `ask` deliberately does NOT block here,
 * matching Claude (mid-stage approval is not this gate's concern). Extracted pure so the gate semantics
 * are unit-testable without the live SDK.
 */
export function piToolCallDecision(
  ctx: PolicyAwareRunnerContext,
  toolName: string,
  input: unknown,
): { block: true; reason: string } | undefined {
  const verdict = ctx.authorizeToolUse?.(toolName, input);
  if (verdict?.verdict === "deny") {
    return { block: true, reason: verdict.reason ?? `tool "${toolName}" denied by policy ${verdict.policy}` };
  }
  return undefined;
}

/**
 * Wire the session's pre-execution gate to the edge policy (DHK-504), mirroring how the Claude adapter
 * hands `canUseTool` to `query()`. Routing every tool call through `ctx.authorizeToolUse` means denials
 * flow through the stage runner's existing `recordDeny` path and allowed actions are deduped from
 * `onTrace` exactly as for Claude - no new recording mechanism. `ctx` is cast to the policy-aware shape
 * the stage runner supplies (as the elicit path already casts for `emitElicit`).
 */
function registerToolCallGate(s: PiSessionLike, ctx: RunnerContext): void {
  const policyCtx = ctx as PolicyAwareRunnerContext;
  s.setToolCallGate?.((toolName, input) => piToolCallDecision(policyCtx, toolName, input));
}

/** One brokered MCP server as the Pi extension consumes it: transport + the node-local proxy url the
 *  agent connects to. Never carries the raw upstream url or the token - both live only in the gateway. */
export interface BrokeredPiMcpServer {
  type: "http" | "sse";
  url: string;
}

/**
 * Brokered MCP servers for Pi (DHK-507): point each declared server at the node's gateway proxy
 * (`${proxyBaseUrl}/<id>`), which holds the token and injects it upstream - the agent never sees the
 * raw secret. The direct analogue of the Claude adapter's `buildBrokeredMcpServers`, minus the SDK
 * `Options` cast (Pi has no native `mcpServers`; the extension below consumes this map). Returns
 * undefined when the stage declares none (or the proxy is absent), so the no-MCP Pi session is
 * unchanged. Module-level + pure so it is unit-testable without the live SDK.
 */
export function buildBrokeredPiMcpServers(ctx: RunnerContext): Record<string, BrokeredPiMcpServer> | undefined {
  const servers = ctx.config.mcpServers;
  if (!servers || servers.length === 0 || !ctx.mcpProxyBaseUrl) return undefined;
  const entries: Record<string, BrokeredPiMcpServer> = {};
  for (const s of servers) entries[s.id] = { type: s.type, url: `${ctx.mcpProxyBaseUrl}/${s.id}` };
  return entries;
}

/**
 * The brokered-MCP bridge extension (DHK-507). Pi 0.80.6 has no native MCP; the seam is an extension
 * whose factory acts as an MCP client. `createAgentSession` awaits every extension factory before
 * startup, so the factory can connect -> list -> register synchronously with respect to the session:
 * for each brokered server it opens an MCP `Client` over Streamable HTTP to the node-local proxy url
 * (`http://127.0.0.1:<port>/<id>` - never the real upstream, never the token), lists the server's
 * tools, and registers each as a Pi tool via `pi.registerTool`. The tool's `execute` proxies to
 * `client.callTool`, so a Pi turn calls a brokered tool like any other and the gateway injects the
 * bearer upstream. A per-server connect/list failure is caught so one bad server contributes no tools
 * without crashing the session (a stage's non-MCP work still runs). The MCP SDK is dynamic-imported so
 * only a stage that actually declares brokered servers loads it. `pi` is typed `any` (the extension
 * API is resolved at runtime, matching `toolGateExtension`).
 */
export function createBrokeredMcpExtension(servers: Record<string, BrokeredPiMcpServer>): {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: (pi: any) => Promise<void>;
} {
  return {
    name: "dahrk-brokered-mcp",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory: async (pi: any) => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      for (const [id, server] of Object.entries(servers)) {
        try {
          const client = new Client({ name: `dahrk-${id}`, version: "0.1.0" });
          await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
          const { tools } = await client.listTools();
          for (const tool of tools) {
            pi.registerTool({
              name: tool.name,
              label: tool.name,
              description: tool.description ?? "",
              // The MCP inputSchema is a JSON-schema object; Pi validates against it at runtime (its
              // custom tools use the same plain-object shape - see the injected tools above).
              parameters: tool.inputSchema,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              execute: async (_toolCallId: string, params: any) => {
                const result = await client.callTool({ name: tool.name, arguments: params ?? {} });
                // MCP's `{ content: [...] }` maps straight onto Pi's `AgentToolResult` (content + details).
                return { content: result.content, details: {} };
              },
            });
          }
        } catch {
          // A server whose connect/list fails contributes no tools rather than throwing out of the
          // factory (which would abort session startup). The token never enters scope regardless.
        }
      }
    },
  };
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

  /**
   * Release the session exactly once (DHK-511). The live factory decorates `dispose()` to also tear
   * down the stage's hermetic config dir (its `auth.json` / `models.json`), so this is the single seam
   * that guarantees the per-stage credentials are cleaned up. It must fire on EVERY terminus - a failed
   * batch, the summarise turn that ends an ok batch, an interactive settle, and cancel - not only on
   * cancel (where `dispose()` historically ran). Idempotent: the guard means a later cancel after a
   * normal settle is a no-op.
   */
  let sessionDisposed = false;
  const disposeSession = (): void => {
    if (sessionDisposed || !session) return;
    sessionDisposed = true;
    try {
      session.dispose();
    } catch {
      /* best effort */
    }
  };

  /**
   * The stage's dollar cost from Pi's aggregate session stats (DHK-434). `getSessionStats()` sums
   * every entry in the session, so a single read at settle covers the whole run (batch, all
   * interactive turns, and the engine-owned summarise turn on the warm session). Returns `undefined`
   * when the session cannot price the run, so the caller omits `costUsd` rather than reporting a
   * fabricated `$0` - which the hub cannot tell from "free" and which silently disables `cost_budget`.
   */
  const readSessionCost = (s: PiSessionLike): number | undefined => {
    const cost = s.getSessionStats?.()?.cost;
    return typeof cost === "number" ? cost : undefined;
  };

  return {
    runtime: "pi",

    async runBatch(ctx, onTrace) {
      const emit = makeEmit("pi", onTrace);
      const s = await openSession(ctx);
      registerToolCallGate(s, ctx);
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
      const costUsd = readSessionCost(s);
      // An ok batch keeps the session warm for the engine-owned summarise turn (its true terminus, which
      // disposes then). A batch that did not settle ok gets no summarise, so runBatch IS the terminus:
      // tear the session (and its hermetic config dir) down here.
      if (status !== "ok") disposeSession();
      return { status, ...(sessionId ? { sessionId } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
    },

    async runInteractive(ctx, turns, onTrace) {
      const emit = makeEmit("pi", onTrace);
      const s = await openSession(ctx);
      registerToolCallGate(s, ctx);
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

      const { firstReplyMs, idleMs } = interactiveIdleWindows(ctx);
      // DHK-505: fan the relayed human-turn stream into (a) conversational turns the loop reads and
      // (b) a blocking `ask` the injected `ask_user_question` tool awaits, so a mid-stage structured
      // question surfaces as a Linear `select` elicitation and the human's pick returns into the same
      // Pi turn. Reuses the exact router the Claude adapter uses, so Pi inherits Claude's
      // one-at-a-time / no-reply / cancel behaviour rather than a Pi-specific variant.
      const router = createElicitTurnRouter(turns, { signal, firstReplyMs, idleMs });
      const humanIter = router.conversation[Symbol.asyncIterator]();
      let awaitingFirstReply = true;

      // The router-backed `ask`: raise one elicitation, block for the human's turn, and map the
      // outcome to the SAME text the Claude adapter returns (claude-adapter.ts) so the model reads an
      // identical result. `emitElicit` (put on the ctx by the stage runner for every runtime) carries
      // the `elicit` wire frame; the preceding trace event is audit-only (the hub maps a trace
      // `elicitation` to null and raises Linear solely from the wire frame, so this does not double-post).
      const elicitCtx = ctx as RunnerContext & { emitElicit?: (question: ElicitQuestion) => void };
      const ask = async (question: ElicitQuestion): Promise<string> => {
        const outcome = await router.ask(awaitingFirstReply, () => {
          emit({ type: "elicitation", prompt: question.prompt, signal: "select", options: question.options });
          elicitCtx.emitElicit?.(question);
        });
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
      };
      // Hand the batch dispatcher to the live session so its `ask_user_question` tool's execute can
      // reach it. A batch of questions is asked one at a time (the router forbids concurrent asks).
      s.setAskUserQuestionHandler?.((questions) => askQuestionsSequentially(questions, ask));

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
      const costUsd = readSessionCost(s);
      // An interactive stage produces its own summary inline (no follow-up summarise turn), so this is
      // its terminus: dispose the session and tear down its hermetic config dir.
      disposeSession();
      return {
        status,
        summary,
        ...(sessionId ? { sessionId } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      } as Omit<JobResult, "jobId">;
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
        // The summarise turn is the terminus of an ok batch stage (runBatch kept the session warm for
        // it): dispose here so the hermetic config dir is torn down on the normal batch path too.
        disposeSession();
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
      disposeSession();
    },
  };
}

/**
 * The live session factory: embed Pi via `createAgentSession` bound to the stage worktree, with the
 * selected auth profile's providers resolved from the broker hint (DHK-511). The SDK is a pinned
 * dependency (`@earendil-works/pi-coding-agent@0.80.6`, published on npm) but is still loaded through a
 * variable-specifier dynamic import as `any` so `tsc` does not resolve its types at build time: the
 * package is loaded lazily only on the live path, so typecheck and the injected-fake tests never need
 * it resolved. This is the live path exercised end-to-end under a managed node and refined by container
 * isolation; the adapter orchestration itself is covered by tests through the injected factory.
 *
 * Provider identity comes solely from the hint (`readAuthHint`), never from inferring it out of an
 * env-var name (the old `PROVIDER_BY_ENV` table is gone). The pure resolution/file-writing logic lives
 * in `pi-auth.ts` and is unit-tested there; this factory is a thin caller:
 *   - API-key providers apply as runtime overrides (`applyApiKeyAuth`); a provider Pi ships no built-in
 *     for gets a `models.json` custom-provider entry from the hint's base URL.
 *   - OAuth-subscription providers persist an `auth.json`, both written into a fresh hermetic per-stage
 *     config dir (never the machine-global `~/.pi`). `AuthStorage`/`ModelRegistry` are pointed at that
 *     dir, and `dispose()` is decorated to tear the whole dir down on teardown.
 */
async function defaultCreatePiSession(ctx: RunnerContext): Promise<PiSessionLike> {
  const spec = "@earendil-works/pi-coding-agent";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(spec);
  const {
    AuthStorage,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
    createAgentSession,
    defineTool,
    getAgentDir,
    resolveCliModel,
  } = mod;

  // The auth-profile hint (DHK-509) is the sole source of provider identity; absent on ambient nodes.
  const hint = readAuthHint(ctx);
  // A fresh per-stage config dir keeps the stage hermetic - Pi never inherits machine-global ~/.pi auth
  // or models config. The OAuth `auth.json` and any custom-provider `models.json` are written into it
  // BEFORE AuthStorage/ModelRegistry are pointed at it, so they are loaded on construction.
  const configDir = createStageConfigDir();
  writeStageAuthFile(configDir, hint);
  writeStageCustomProviders(configDir, hint);

  const authStorage = AuthStorage.create(join(configDir, "auth.json"));
  // Brokered API-key providers apply as runtime overrides (AuthStorage's highest-priority, non-persisted
  // source) so Pi resolves them as if set by the operator and the agent never sees the raw secret. The
  // secret rides in `runtimeEnv`; the hint declares which var carries which provider's key.
  applyApiKeyAuth(hint, ctx.runtimeEnv, authStorage);
  const modelRegistry = ModelRegistry.create(authStorage, join(configDir, "models.json"));

  let model: unknown;
  if (ctx.config.model) {
    const resolved = resolveCliModel({ cliModel: ctx.config.model, modelRegistry });
    if (!resolved?.error) {
      model = pickAuthedModel(resolved?.model, modelRegistry.getAvailable());
    }
  }

  // The injected stage-complete tool (interactive tool-exit); harmless on batch stages.
  const stageComplete = defineTool({
    name: PI_STAGE_COMPLETE_TOOL,
    label: "Stage complete",
    description: "End the current stage and hand off a one-sentence summary of what was accomplished.",
    parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    execute: async () => ({ content: [{ type: "text", text: "Stage marked complete." }], details: {} }),
  });

  // The injected structured-question tool (DHK-505). Seam decision: the SHADOW TOOL, not Pi's host UI
  // adapter (`ExtensionUIContext.select`). Two facts about the pinned 0.80.6 API decide it:
  //  1. `ctx.ui.select(title, options: string[])` carries only a flat list of option strings and
  //     returns a single `string | undefined` - it cannot carry an option's description or the
  //     multiSelect flag, so it would lose the structured `ElicitQuestion` shape.
  //  2. `ctx.ui.*` is an EXTENSION-facing API; Pi has no built-in model-facing structured-question
  //     tool (no `AskUserQuestion` analogue) that routes to it, so the model cannot reach `ui.select`.
  // Only a custom tool the model can call, whose `execute` runs inside the live session, can both
  // raise the question and return the human's pick back into the turn as a tool result. `execute`
  // routes through the adapter's dispatcher (`setAskUserQuestionHandler`), which drives the shared
  // elicit router -> `emitElicit`, matching the Claude AskUserQuestion->Linear path.
  let askHandler: ((questions: AskUserQuestions) => Promise<string>) | undefined;
  const askUserQuestion = defineTool({
    name: PI_ASK_USER_QUESTION_TOOL,
    label: "Ask the user a question",
    description:
      "Ask the human a structured multiple-choice question and wait for their selection. Use this " +
      "when you need the human to choose between options before you can continue.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: { label: { type: "string" }, description: { type: "string" } },
                  required: ["label"],
                },
              },
              multiSelect: { type: "boolean" },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_toolCallId: string, params: any) => {
      // No handler registered (e.g. a batch stage, which never wires elicitation): degrade to the
      // same soft note the router's no-reply path returns rather than blocking or erroring.
      const text = askHandler
        ? await askHandler((params as { questions: AskUserQuestions }).questions)
        : "No response from the user; proceed with your best judgement.";
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // The pre-execution tool gate (DHK-504). Pi's veto is its extension `tool_call` hook, which fires
  // before a tool's `execute` and returns `{ block, reason }` - the direct analogue of Claude's
  // `canUseTool`. `createAgentSession` has no direct `tool_call` option; the hook reaches it only via a
  // ResourceLoader carrying an inline extension. So register an inline extension whose factory subscribes
  // `tool_call` to the adapter-supplied gate (set by `setToolCallGate` below), covering built-in
  // (read/bash/edit/write/grep/find/ls) and custom tools alike - every event carries `toolName`/`input`.
  let toolCallGate: ((toolName: string, input: unknown) => { block?: boolean; reason?: string } | undefined) | undefined;
  const toolGateExtension = {
    name: "dahrk-tool-gate",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory: (pi: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pi.on("tool_call", (event: any) => toolCallGate?.(event.toolName, event.input));
    },
  };
  // Supplying our own ResourceLoader replaces the one `createAgentSession` would build, so replicate the
  // SDK's own default construction (dist/core/sdk.js) field-for-field and only ADD `extensionFactories`,
  // then reload ourselves (the SDK reloads only a loader it built): skill/prompt-template/context-file
  // loading is unchanged, and the inline gate extension is registered. `getAgentDir()` is the SDK's own
  // default agent dir (`~/.pi/agent`); `SettingsManager.create(cwd, agentDir)` matches the SDK default.
  const cwd = ctx.workspace.worktreePath;
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  // Brokered MCP (DHK-507): when the stage declares MCP servers and the node started its gateway
  // proxy (`mcpProxyBaseUrl`), add the bridge extension that registers each brokered server's tools,
  // routed through `127.0.0.1/<id>`. Absent -> only `toolGateExtension`, so the no-MCP session is
  // byte-for-byte unchanged.
  const brokeredMcp = buildBrokeredPiMcpServers(ctx);
  const extensionFactories = brokeredMcp
    ? [toolGateExtension, createBrokeredMcpExtension(brokeredMcp)]
    : [toolGateExtension];
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(ctx.workspace.worktreePath),
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    cwd,
    customTools: [stageComplete, askUserQuestion],
    ...(model ? { model } : {}),
  });
  const piSession = session as PiSessionLike;
  // Decorate dispose() to tear down the hermetic config dir (the OAuth auth.json / custom models.json)
  // when the runner releases the session. The runner disposes on EVERY terminus - failed batch, the
  // summarise turn that ends an ok batch, an interactive settle, and cancel - so the per-stage
  // credentials never outlive the stage.
  const innerDispose = piSession.dispose.bind(piSession);
  piSession.dispose = (): void => {
    try {
      innerDispose();
    } finally {
      cleanupStageConfigDir(configDir);
    }
  };
  // The adapter's `runInteractive` registers its dispatcher here; the tool's `execute` above reads it.
  piSession.setAskUserQuestionHandler = (handler) => {
    askHandler = handler;
  };
  // The adapter's run loops register the pre-execution gate here; the inline extension above reads it.
  piSession.setToolCallGate = (gate) => {
    toolCallGate = gate;
  };
  return piSession;
}

/** The minimum of a Pi model we depend on. The SDK's own type is not resolved at build time (the
 *  package is imported by variable specifier), so we describe only what we read. */
export interface PiModelLike {
  id: string;
  provider: string;
}

/**
 * The model id with its provider's packaging stripped, so the SAME model can be recognised across
 * providers: Bedrock's `us.anthropic.claude-opus-4-8` and Anthropic's `claude-opus-4-8` are one model
 * reached two ways. Take the last dot-segment (dropping a `us.` / `eu.` region and an `anthropic.`
 * vendor prefix) and drop a trailing `-v1:0`-style revision.
 */
function modelFamily(id: string): string {
  const last = id.split(".").pop() ?? id;
  return last.replace(/-v\d+:\d+$/, "").toLowerCase();
}

/**
 * Land a resolved model on a provider we can actually authenticate to.
 *
 * `resolveCliModel` resolves an alias against the WHOLE registry - over a thousand models across
 * thirty-odd providers - and the bare aliases every Dahrk workflow uses (`sonnet`, `opus`, `haiku`)
 * land on **amazon-bedrock**: `opus` becomes `us.anthropic.claude-opus-4-8`. On a managed node the hub
 * brokers an *Anthropic* key, so Pi would ask Bedrock for a credential that does not exist and the
 * stage died on its first turn with "No API key found for amazon-bedrock". Nothing about this is
 * specific to Anthropic; the same trap sits under every alias for every provider.
 *
 * `registry.getAvailable()` is Pi's own answer to "which models can this auth storage actually use",
 * and it already accounts for the runtime keys the broker injected. So: if the resolved model's
 * provider is not one of those, prefer the same model family from the available set. Deterministic,
 * and it never invents a model - if nothing available matches, the resolution is left exactly as Pi
 * made it so Pi raises its own clear error rather than one we fabricate.
 *
 * With no available models at all (nothing brokered, ambient/self-managed node), this is a no-op:
 * Pi resolves against whatever the operator has configured, exactly as before.
 */
export function pickAuthedModel(
  resolved: PiModelLike | undefined,
  available: readonly PiModelLike[] | undefined,
): PiModelLike | undefined {
  if (!resolved || !available?.length) return resolved;
  const providers = new Set(available.map((m) => m.provider));
  if (providers.has(resolved.provider)) return resolved;
  const family = modelFamily(resolved.id);
  return available.find((m) => modelFamily(m.id) === family) ?? resolved;
}
