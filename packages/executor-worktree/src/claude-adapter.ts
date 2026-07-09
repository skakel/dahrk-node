/**
 * The Claude runner adapter: a thin wrapper over @anthropic-ai/claude-agent-sdk's
 * streaming `query()` API behind the contract `Runner`. It runs a stage to a terminal
 * result (batch) or across multi-turn human input (interactive), emits the normalised
 * trace envelope through the stage runner's `onTrace` as messages arrive, issues the
 * engine-owned summarisation turn, and cancels cleanly.
 *
 * No LLM call decides control flow: this is the inside of a stage. Sequencing, gates and
 * branching are the engine's, upstream of here. The pure SDK-message mapping lives in
 * ./claude-mappers.ts; the CYPACK-1177 buffered-response rule lives in the streaming loop
 * below (decide the response from the last assistant text, never from a turn that ends on
 * a tool call).
 */
import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { HumanTurn, JobResult, JobStatus, PolicyOutcome, Runner, RunnerContext } from "@dahrk/contracts";
import { consumeClaudeMessage, newBufferState, type BufferState } from "./claude-mappers.js";
import {
  makeEmit,
  raceNextTurn,
  interactiveIdleWindows,
  resolveStagePrompt,
  hasSystemPrompt,
  interactiveSeedText,
  SUMMARISE_PROMPT,
  ManagedMailbox,
  type EmittableEvent,
} from "./runner-shared.js";
import { createStageCompleteTool } from "./stage-complete-tool.js";

/** Debounce window for coalescing a burst of rapid human turns into one user message. */
const COALESCE_MS = Number(process.env.DAHRK_COALESCE_MS ?? process.env.SKAKEL_COALESCE_MS ?? 40);
/** Hard turn ceiling so a runaway interactive session cannot loop indefinitely. */
const MAX_TURNS = Number(process.env.DAHRK_MAX_TURNS ?? process.env.SKAKEL_MAX_TURNS ?? 64);

/** Default worktree-relative path stamped on a document handed back via `dahrk_stage_complete`
 *  when the stage declared no `emitArtifact`. Kept under the scratch output convention so it reads
 *  naturally in obs; the hub's `attach-document` resolves by content, not this exact path. */
const HANDED_BACK_ARTIFACT_PATH = ".skakel/scratch/output/document.md";

/**
 * Anchor every stage to its worktree. The claude_code preset injects the dynamic
 * working-directory + git-status sections the model needs so it operates from its cwd and
 * never guesses an absolute repo path. Set here, once, so it applies to all workloads without
 * a per-workflow prompt nudge. (Omitting systemPrompt left the batch stage with no cwd context.)
 */
const CLAUDE_CODE_SYSTEM_PROMPT = { type: "preset", preset: "claude_code" } as const;

type PolicyAwareRunnerContext = RunnerContext & {
  authorizeToolUse?: (toolName: string, input: unknown) => PolicyOutcome;
};

const userMsg = (text: string): SDKUserMessage => ({
  type: "user",
  parent_tool_use_id: null,
  message: { role: "user", content: text },
});

const sessionIdOf = (msg: SDKMessage): string | undefined =>
  "session_id" in msg && typeof msg.session_id === "string" ? msg.session_id : undefined;

const policyCanUseTool = async (
  ctx: PolicyAwareRunnerContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }> => {
  const verdict = ctx.authorizeToolUse?.(toolName, input);
  if (verdict?.verdict === "deny") {
    return { behavior: "deny", message: verdict.reason ?? `tool "${toolName}" denied by policy ${verdict.policy}` };
  }
  return { behavior: "allow", updatedInput: input };
};

/**
 * Brokered MCP servers: point each declared server at the node's gateway proxy
 * (`${proxyBaseUrl}/<id>`), which holds the token and injects it upstream - the agent never sees the
 * raw secret. Programmatic `mcpServers` take precedence over a same-named entry in the repo
 * `.mcp.json`, so a brokered server overrides its unauthenticated repo definition. Returns undefined
 * when the stage declares none (or the proxy is absent), leaving repo `.mcp.json` untouched.
 * Module-level + pure so it is unit-testable without invoking the SDK.
 */
export function buildBrokeredMcpServers(ctx: RunnerContext): Options["mcpServers"] | undefined {
  const servers = ctx.config.mcpServers;
  if (!servers || servers.length === 0 || !ctx.mcpProxyBaseUrl) return undefined;
  const entries: Record<string, { type: "http" | "sse"; url: string }> = {};
  for (const s of servers) entries[s.id] = { type: s.type, url: `${ctx.mcpProxyBaseUrl}/${s.id}` };
  return entries as Options["mcpServers"];
}

export function createClaudeRunner(): Runner {
  const abortController = new AbortController();
  let cancelled = false;
  let active: Query | undefined;
  let sessionId: string | undefined;
  let costUsd: number | undefined;

  const baseOptions = (ctx: RunnerContext): Options => ({
    cwd: ctx.workspace.worktreePath,
    abortController,
    // The deterministic push-stage commit sets the harness author identity itself (see
    // GitService.commitAndPush); when the Claude runtime commits inside an interactive stage it must
    // NOT append its own `Co-Authored-By: Claude <noreply@anthropic.com>` trailer. `includeCoAuthoredBy`
    // is a Claude Code SETTINGS key (not a top-level Options field), so it rides the inline `settings`
    // object, which sits at the flag layer and overrides any project/local setting. Mirrors the cyrus
    // reference (EdgeWorker.ts writes the same key into .claude/settings.local.json).
    settings: { includeCoAuthoredBy: false },
    // Inherit the REPO's .mcp.json / .claude settings (build spec section 9): do NOT set
    // strictMcpConfig. Policy enforcement around tools is M6; M4 allows tools to run and the
    // stage runner intercepts denied actions at the trace level.
    // Deliberately EXCLUDE "user": a stage must be hermetic to the worktree and not inherit the
    // edge operator's ~/.claude (their CLAUDE.md, settings, memory), which is machine-specific and
    // bleeds non-deterministic context across edges. "project"/"local" honour the repo's own
    // .claude/ + CLAUDE.md + .mcp.json, which is all section 9 actually requires. Claude auth is
    // keychain/OAuth and independent of settingSources, so dropping "user" does not affect it.
    settingSources: ["project", "local"],
    ...(ctx.config.model ? { model: ctx.config.model } : {}),
    ...(ctx.sessionId ? { resume: ctx.sessionId } : {}),
    ...(ctx.config.skill ? { skills: [ctx.config.skill] } : {}),
  });

  /**
   * Emit the trace for one SDK message: capture the session id, persist the raw record, then
   * fold it through the pure buffered-response state machine (consumeClaudeMessage) and emit
   * the resulting events. Returns whether this was a turn-settling `result` and its response.
   */
  const handleMessage = (
    msg: SDKMessage,
    emit: (e: EmittableEvent, rawRef?: string) => void,
    ctx: RunnerContext,
    state: BufferState,
    suppressStageExit: boolean,
  ): { isResult: boolean; status?: JobStatus; responseText?: string } => {
    const found = sessionIdOf(msg);
    if (found) sessionId = found;
    if (msg.type === "result" && typeof msg.total_cost_usd === "number") costUsd = msg.total_cost_usd;
    const rawRef = ctx.writeRaw?.(msg);
    const res = consumeClaudeMessage(msg, state, suppressStageExit);
    for (const e of res.events) emit(e, rawRef);
    return { isResult: res.isResult, status: res.status, responseText: res.responseText };
  };

  const closeActive = (): void => {
    try {
      active?.close();
    } catch {
      /* best effort */
    }
    active = undefined;
  };

  return {
    runtime: "claude-code",

    async runBatch(ctx, onTrace) {
      const emit = makeEmit("claude-code", onTrace);
      const prompt = resolveStagePrompt(ctx);
      const mcpServers = buildBrokeredMcpServers(ctx);
      const options: Options = {
        ...baseOptions(ctx),
        systemPrompt: CLAUDE_CODE_SYSTEM_PROMPT,
        // Brokered MCP servers merged additively with the repo's .mcp.json (settingSources).
        // Tools stay allowed by canUseTool below; we do NOT set a restrictive allowedTools here.
        ...(mcpServers ? { mcpServers } : {}),
        // Headless: allow tools to run without an interactive permission prompt (M6 wires policy).
        canUseTool: async (toolName, input) => policyCanUseTool(ctx, toolName, input),
      };
      const state = newBufferState();
      let status: JobStatus = "ok";
      try {
        const q = query({ prompt, options });
        active = q;
        for await (const msg of q) {
          const res = handleMessage(msg, emit, ctx, state, false);
          if (res.isResult && res.status) status = res.status;
        }
      } catch (e) {
        if (!cancelled) emit({ type: "error", kind: "runtime_error", message: (e as Error).message });
        status = "fail";
      } finally {
        closeActive();
      }
      if (cancelled) status = "fail";
      return { status, ...(sessionId ? { sessionId } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
    },

    async runInteractive(ctx, turns, onTrace) {
      const emit = makeEmit("claude-code", onTrace);
      const stageTool = createStageCompleteTool();
      // Interactive stages have full tool parity with batch stages: a prompt that writes files or
      // explores the repo works the same as in a batch stage (customers bring all kinds of prompts,
      // and Pi/Codex interactive already allow tools). The S2 spike gated tools to keep the stage
      // conversational and avoid an execute-loop that never settled a per-turn result; that risk is
      // accepted here and bounded by maxTurns (forces a result) plus the edge's job.timeout wall-clock
      // kill. Edge policy still observes every action via onTrace exactly as for batch. The one
      // exception is the gate-exit summarisation turn below, which stays recap-only (no tools).
      const brokered = buildBrokeredMcpServers(ctx);
      let summarising = false;
      const options: Options = {
        ...baseOptions(ctx),
        // Keep the cwd-anchoring preset; fold the stage instruction in via `append` so the
        // interactive persona still gets it without losing the working-directory context.
        systemPrompt: hasSystemPrompt(ctx)
          ? { type: "preset", preset: "claude_code", append: resolveStagePrompt(ctx) }
          : CLAUDE_CODE_SYSTEM_PROMPT,
        // Inject the stage-complete exit tool alongside any brokered MCP servers (parity with batch).
        mcpServers: { dahrk: stageTool.server, ...(brokered ?? {}) },
        // Auto-approve the exit tool; `allowedTools` is an auto-approve list, not a whitelist, so it
        // does not restrict the other tools canUseTool allows.
        allowedTools: [stageTool.allowedToolName],
        canUseTool: async (toolName, input) =>
          summarising && toolName !== stageTool.allowedToolName
            ? { behavior: "deny", message: "Summarise from the work you just did; reply with the sentence only, no tools." }
            : policyCanUseTool(ctx, toolName, input),
        maxTurns: MAX_TURNS,
        includePartialMessages: false,
      };
      const exit = ctx.config.exit ?? "gate";
      const wantsTool = exit === "tool" || exit === "either";

      const mailbox = new ManagedMailbox<SDKUserMessage>();
      const q = query({ prompt: mailbox, options });
      active = q;
      const it = q[Symbol.asyncIterator]();
      const humanIter = turns[Symbol.asyncIterator]();
      const state = newBufferState();

      // Pull messages until the in-flight turn settles on a `result`; return its response text.
      const consumeTurn = async (): Promise<string | undefined> => {
        for (;;) {
          const { value: msg, done } = (await it.next()) as IteratorResult<SDKMessage>;
          if (done) return undefined;
          const res = handleMessage(msg, emit, ctx, state, true);
          if (res.isResult) return res.responseText;
        }
      };

      const { firstReplyMs, idleMs } = interactiveIdleWindows(ctx);
      let awaitingFirstReply = true;
      let exited: "tool" | "gate" | "timeout" | "cancelled" | null = null;
      let pending = humanIter.next();
      try {
        // Self-seed the opening turn: an interactive stage is triggered by a Linear label
        // or mention whose text rides in `issueContext` (the system prompt), never as a queued human
        // turn, so open the interview ourselves. Without this the runner idled on `raceNextTurn`
        // until the idle timeout with the model never running (status timeout, $0, no trace events).
        mailbox.push(userMsg(interactiveSeedText(ctx, hasSystemPrompt(ctx))));
        await consumeTurn();
        if (stageTool.fired() && wantsTool) exited = "tool";
        while (exited === null) {
          // The first wait is for the human's opening reply (longer budget); later waits are
          // inter-turn idles once the conversation is live.
          const race = await raceNextTurn(pending, awaitingFirstReply ? firstReplyMs : idleMs, abortController.signal);
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
          // race.kind === "turn": coalesce a burst of rapid turns into one user message.
          const texts: string[] = [(race.value as HumanTurn).text];
          pending = humanIter.next();
          for (;;) {
            const more = await raceNextTurn(pending, COALESCE_MS, abortController.signal);
            if (more.kind === "turn") {
              texts.push((more.value as HumanTurn).text);
              pending = humanIter.next();
              continue;
            }
            if (more.kind === "cancelled") exited = "cancelled";
            // idle-timeout (debounce elapsed, `pending` still live and carried) or
            // turns-exhausted (resolved-done, re-raced next iteration): stop coalescing.
            break;
          }
          if (exited === "cancelled") break;
          mailbox.push(userMsg(texts.join("\n")));
          await consumeTurn();
          if (stageTool.fired() && wantsTool) {
            exited = "tool";
            break;
          }
        }
      } catch (e) {
        if (!cancelled && !exited) emit({ type: "error", kind: "runtime_error", message: (e as Error).message });
        exited = exited ?? (cancelled ? "cancelled" : "gate");
      }

      let status: JobStatus = "ok";
      let summary = "";
      if (exited === "tool") {
        summary = stageTool.summary() ?? "(stage marked complete)";
      } else if (exited === "gate") {
        // Turns exhausted with no tool exit: one engine-owned summarisation turn. Keep it recap-only
        // (deny tools for this turn) so the final handoff summary is prose, not more stage work.
        summarising = true;
        try {
          mailbox.push(userMsg(SUMMARISE_PROMPT));
          const reply = await consumeTurn();
          summary = (reply ?? "").trim() || "(no summary produced)";
        } catch {
          summary = "(no summary produced)";
        } finally {
          summarising = false;
        }
      } else if (exited === "timeout") {
        status = "timeout";
        summary = "(stage timed out awaiting input)";
        await this.cancel();
      } else {
        status = "fail";
        summary = "(stage cancelled)";
      }

      mailbox.end();
      // Drain any trailing messages, then close.
      try {
        for (;;) {
          const { done } = await it.next();
          if (done) break;
        }
      } catch {
        /* best effort */
      }
      closeActive();
      // A deliverable handed back through `dahrk_stage_complete`'s `document` field rides out as the
      // stage artifact. This is the optional in-band channel; an interactive stage may equally write
      // the file itself (tools are allowed), in which case the edge resolver prefers that written
      // file over this handoff. Path it at the stage's declared `emitArtifact` (so `attach-document`'s
      // `from:` matches) or a default; the edge caps and folds it onto `projection.artifacts`.
      const handedBackDoc = status === "ok" ? stageTool.document() : null;
      const artifact =
        handedBackDoc !== null
          ? { path: ctx.config.emitArtifact ?? HANDED_BACK_ARTIFACT_PATH, content: handedBackDoc }
          : undefined;
      return {
        status,
        summary,
        ...(sessionId ? { sessionId } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(artifact ? { artifact } : {}),
      } as Omit<JobResult, "jobId">;
    },

    async summarise(ctx) {
      // The engine-owned handoff turn: reuse the warm batch session by resuming it for a
      // constrained turn. It must not emit trace events (it is not the agent's stage work).
      // The resumed session carries the agentic claude_code preset, so DENY tools here: the
      // model must summarise from what it just did rather than starting fresh stage work. A
      // small turn budget (not 1) absorbs a denied-tool detour so the text answer still lands.
      if (!sessionId) return "(no summary: session not established)";
      const options: Options = {
        ...baseOptions(ctx),
        resume: sessionId,
        maxTurns: 4,
        canUseTool: async () => ({
          behavior: "deny",
          message: "Summarise from the work you just did; reply with the sentence only, no tools.",
        }),
      };
      try {
        let out = "";
        const q = query({ prompt: SUMMARISE_PROMPT, options });
        active = q;
        for await (const msg of q) {
          const found = sessionIdOf(msg);
          if (found) sessionId = found;
          if (msg.type === "result" && msg.subtype === "success") out += msg.result;
        }
        return out.trim() || "(no summary produced)";
      } catch (e) {
        return `(summary unavailable: ${(e as Error).message})`;
      } finally {
        closeActive();
      }
    },

    async cancel() {
      if (cancelled) return;
      cancelled = true;
      try {
        await active?.interrupt();
      } catch {
        /* best effort */
      }
      abortController.abort();
    },
  };
}
