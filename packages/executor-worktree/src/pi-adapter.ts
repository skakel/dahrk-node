/**
 * The Pi runtime adapter: a thin wrapper over @earendil-works/pi-coding-agent's embedded
 * `AgentSession` behind the contract `Runner`. Pi is the model-agnostic runtime (the platform
 * managed node): a single runtime that attaches different provider subscriptions via brokered
 * inference creds (`runtimeEnv`). It runs a stage to a terminal result
 * (batch) or across multi-turn human input (interactive), emitting the SAME normalised trace
 * envelope the Claude adapter produces, supplies the engine-owned summary, and
 * cancels cleanly.
 *
 * No LLM call decides control flow: this is the inside of a stage. The pure event -> envelope
 * mapping lives in ./pi-mappers.ts. Pi has no live low-latency prompt injection, so interactive
 * turns resume one at a time (each human turn is one `session.prompt()` awaited to completion).
 *
 * The live SDK is reached through a small injectable session factory (`PiSessionFactory`).
 * `createPiRunner()` defaults to the real `createAgentSession`; tests inject a scripted fake
 * session, so the adapter's orchestration is exercised without live inference or credentials
 * (mirroring how the pure mappers are unit-tested). The real SDK is loaded via a lazy dynamic
 * import so the build does not hard-depend on a live Pi install.
 */
import { join } from "node:path";
import type { JobStatus, Runner, RunnerContext } from "@dahrk/contracts";
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
  SUMMARISE_PROMPT,
  type PolicyAwareRunnerContext,
  type RuntimeSession,
  type RuntimeSessionHooks,
  type TurnResult,
} from "./runtime-session.js";
import { elicitOutcomeReply } from "./elicit-router.js";
import { runInteractiveLoop, runBatchLoop } from "./turn-loop.js";
import { askQuestionsSequentially } from "./ask-user-question-tool.js";

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

/** The initial `hooks.ask` before an interactive loop installs the router-backed one. Never invoked on
 *  the batch/summarise paths (they wire no `ask_user_question` handler); the interactive loop replaces
 *  it before the opening turn. Degrades to the same soft note the router's no-reply path returns. */
const defaultAsk = async (): Promise<string> => elicitOutcomeReply({ kind: "noreply" });

/**
 * The single Pi `RuntimeSession` over the low-level `PiSessionLike` transport, used for BOTH back-ends
 * (embedded `defaultCreatePiSession` and container `PiRpcSession`), so both drive the one shared loop
 * with zero mapping duplication. The Pi-specific concerns live here, above the transport seam and below
 * the runtime-agnostic loop:
 *   - `sendTurn`: subscribe, persist raw via `ctx.writeRaw`, detect the injected stage-complete tool
 *     (capture its handoff `summary`, keep it out of the trace), map every other event through
 *     `consumePiEvent`, and let a thrown `prompt()` propagate so the loop owns the terminal decision.
 *     `interactive` selects `suppressStageExit` (batch `false` emits the per-turn stage-exit; the
 *     interactive stage runner owns the single final one, so `true`).
 *   - `summariseTurn`: deny tools (a documented no-op on `PiRpcSession`, which has no `agent`), run
 *     `SUMMARISE_PROMPT`, return the captured text - emitting no trace.
 *   - `cost`: Pi's aggregate `getSessionStats().cost` (DHK-434); `undefined` when unpriced, never `0`.
 */
function makePiRuntimeSession(
  s: PiSessionLike,
  ctx: RunnerContext,
  hooks: RuntimeSessionHooks,
  interactive: boolean,
): RuntimeSession {
  return {
    get sessionId(): string | undefined {
      return s.sessionId;
    },
    async sendTurn(text: string): Promise<TurnResult> {
      const state = newPiBufferState();
      let stageComplete = false;
      let summary: string | undefined;
      let stageCompleteCallId: string | undefined;
      let responseText: string | undefined;
      let status: JobStatus | undefined;
      const unsub = s.subscribe((ev) => {
        const rawRef = ctx.writeRaw?.(ev);
        if (ev.type === "tool_execution_start" && ev.toolName === PI_STAGE_COMPLETE_TOOL) {
          stageComplete = true;
          stageCompleteCallId = ev.toolCallId;
          const args = ev.args as { summary?: string } | undefined;
          if (args?.summary) summary = args.summary;
          return;
        }
        if (ev.type === "tool_execution_end" && ev.toolCallId === stageCompleteCallId) return;
        const r = consumePiEvent(ev, state, interactive);
        for (const e of r.events) hooks.emit(e, rawRef);
        if (r.responseText) responseText = r.responseText;
        if (r.isResult && r.status) status = r.status;
      });
      try {
        await s.prompt(text);
      } finally {
        unsub();
      }
      return {
        stageComplete,
        ...(summary !== undefined ? { summary } : {}),
        ...(responseText !== undefined ? { responseText } : {}),
        ...(status !== undefined ? { status } : {}),
      };
    },
    async summariseTurn(): Promise<string> {
      // Deny tools so the model recaps what it just did rather than starting fresh work. A no-op on
      // `PiRpcSession` (no `agent` handle) - accepted; meta-loop stages are telemetry-only.
      if (s.agent) s.agent.state.tools = [];
      const state = newPiBufferState();
      let out: string | undefined;
      const unsub = s.subscribe((ev) => {
        const r = consumePiEvent(ev, state, true);
        if (r.responseText) out = r.responseText;
      });
      try {
        await s.prompt(SUMMARISE_PROMPT);
        return (out ?? "").trim() || "(no summary produced)";
      } catch (e) {
        return `(summary unavailable: ${(e as Error).message})`;
      } finally {
        unsub();
      }
    },
    cost(): number | undefined {
      const cost = s.getSessionStats?.()?.cost;
      return typeof cost === "number" ? cost : undefined;
    },
    dispose(): void {
      s.dispose();
    },
  };
}

export function createPiRunner(deps: PiRunnerDeps = {}): Runner {
  const createSession = deps.createSession ?? defaultCreatePiSession;
  const abortController = new AbortController();
  const signal = abortController.signal;
  let cancelled = false;
  let session: PiSessionLike | undefined;

  /** Open the session once and keep it warm so `summarise()` reuses the batch session. */
  const openSession = async (ctx: RunnerContext): Promise<PiSessionLike> => {
    if (!session) session = await createSession(ctx);
    return session;
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

  return {
    runtime: "pi",

    async runBatch(ctx, onTrace) {
      const hooks: RuntimeSessionHooks = { emit: makeEmit("pi", onTrace), ask: defaultAsk };
      const s = await openSession(ctx);
      registerToolCallGate(s, ctx);
      const rt = makePiRuntimeSession(s, ctx, hooks, false);
      const result = await runBatchLoop(rt, ctx, hooks, { cancelled: () => cancelled });
      // An ok batch keeps the session warm for the engine-owned summarise turn (its true terminus, which
      // disposes then). A batch that did not settle ok gets no summarise, so runBatch IS the terminus:
      // tear the session (and its hermetic config dir) down here.
      if (result.status !== "ok") disposeSession();
      return result;
    },

    async runInteractive(ctx, turns, onTrace) {
      const emit = makeEmit("pi", onTrace);
      const s = await openSession(ctx);
      registerToolCallGate(s, ctx);
      // DHK-505: route the live session's injected `ask_user_question` tool through the shared elicit
      // router. The loop assembles the router-backed hooks and calls this factory with them, so the
      // handler is wired to the FINAL `ask` at construction (no lazy read of a swapped field). A batch of
      // questions is asked one at a time (the router forbids concurrent asks).
      const makeSession = (hooks: RuntimeSessionHooks): RuntimeSession => {
        s.setAskUserQuestionHandler?.((questions) => askQuestionsSequentially(questions, (q) => hooks.ask(q)));
        return makePiRuntimeSession(s, ctx, hooks, true);
      };
      const result = await runInteractiveLoop(ctx, turns, emit, makeSession, {
        signal,
        cancelled: () => cancelled,
        cancel: () => this.cancel(),
        instructionInSystemPrompt: false,
      });
      // An interactive stage produces its own summary inline (no follow-up summarise turn), so this is
      // its terminus: dispose the session and tear down its hermetic config dir.
      disposeSession();
      return result;
    },

    async summarise(ctx) {
      // Engine-owned handoff turn: reuse the warm in-closure session for one constrained turn on the
      // `RuntimeSession` port (deny tools, emit no trace). ctx is unused: the warm session already
      // carries the worktree + model.
      if (!session) return "(no summary: session not established)";
      const rt = makePiRuntimeSession(session, ctx, { emit: () => {}, ask: defaultAsk }, true);
      try {
        return await rt.summariseTurn();
      } finally {
        // The summarise turn is the terminus of an ok batch stage (runBatch kept the session warm for
        // it): dispose here so the hermetic config dir is torn down on the normal batch path too.
        disposeSession();
      }
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
      model = pickAuthedModel(resolved?.model, modelRegistry.getAvailable(), hint?.defaultModel);
    }
  } else if (hint?.defaultModel) {
    // No stage model at all: the profile's model is then the only expression of intent, so honour it
    // rather than leaving Pi on its own global default (which the hermetic config dir has stripped of
    // any operator preference anyway).
    const resolved = resolveCliModel({ cliModel: hint.defaultModel, modelRegistry });
    if (!resolved?.error) model = pickAuthedModel(resolved?.model, modelRegistry.getAvailable());
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
        : elicitOutcomeReply({ kind: "noreply" });
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
 *
 * `fallbackModel` is the LAST resort (the selected auth profile's `defaultModel`), for when the family
 * match cannot succeed because the brokered provider serves a different model line entirely. A Codex
 * subscription is the motivating case: `sonnet` resolves to `us.anthropic.claude-…` on amazon-bedrock,
 * and no `openai-codex` model is in the `claude` family, so family matching finds nothing and - without
 * this - the resolution stays on Bedrock and the stage dies on its first turn asking for a credential
 * that was never brokered. Falling back keeps tier aliases meaningful in workflows while letting a pool
 * change provider by changing a profile field.
 */
export function pickAuthedModel(
  resolved: PiModelLike | undefined,
  available: readonly PiModelLike[] | undefined,
  fallbackModel?: string,
): PiModelLike | undefined {
  if (!resolved || !available?.length) return resolved;
  const providers = new Set(available.map((m) => m.provider));
  if (providers.has(resolved.provider)) return resolved;
  const family = modelFamily(resolved.id);
  const sameFamily = available.find((m) => modelFamily(m.id) === family);
  if (sameFamily) return sameFamily;
  if (fallbackModel) {
    // Match the fallback against what the auth can actually reach, by exact id then by family, so a
    // profile naming `gpt-5.5` still lands if the provider packages it under a decorated id. Never
    // invent one: an unmatched fallback leaves Pi's own resolution alone so IT raises the clear error.
    const byId = available.find((m) => m.id === fallbackModel);
    if (byId) return byId;
    const byFamily = available.find((m) => modelFamily(m.id) === modelFamily(fallbackModel));
    if (byFamily) return byFamily;
  }
  return resolved;
}
