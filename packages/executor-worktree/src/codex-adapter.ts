/**
 * The Codex runner adapter: a thin wrapper over @openai/codex-sdk behind the contract
 * `Runner`. It runs a stage to a terminal result (batch) or across multi-turn human input
 * (interactive, resume-per-turn), emitting the SAME normalised trace envelope the Claude
 * adapter produces, supplies the engine-owned summary, and cancels cleanly.
 *
 * No LLM call decides control flow: this is the inside of a stage. The pure thread-event
 * mapping lives in ./codex-mappers.ts. Unlike Claude, Codex has no live streaming-prompt
 * injection, so interactive turns resume the thread one at a time.
 */
import { Codex, type Thread, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import type { HumanTurn, JobResult, JobStatus, Runner, RunnerContext } from "@dahrk/contracts";
import { mapCodexEvent } from "./codex-mappers.js";
import { makeEmit, raceNextTurn, interactiveIdleWindows, resolveStagePrompt, interactiveSeedText, SUMMARISE_PROMPT, type EmittableEvent } from "./runner-shared.js";

const COALESCE_MS = Number(process.env.DAHRK_COALESCE_MS ?? process.env.SKAKEL_COALESCE_MS ?? 40);

/**
 * Brokered inference for a credential-less node (DHK-89). A managed / Docker-isolated node has no
 * ambient `codex` login, so the hub mints the provider key into `runtimeEnv` (codex -> OPENAI_API_KEY)
 * and delivers it on the Job; the edge threads it onto the RunnerContext. Returns the Codex SDK's
 * `env` option merging `runtimeEnv` over `process.env`, or `{}` on ambient nodes (the SDK then
 * inherits process.env, the operator's ambient login). The SDK's `env` REPLACES the inherited
 * environment, so process.env (PATH, HOME, ...) must be carried through or the CLI cannot spawn; its
 * `undefined` values are dropped so the result satisfies the SDK's `Record<string, string>` type.
 */
export function runtimeEnvOptions(ctx: RunnerContext): { env?: Record<string, string> } {
  if (!ctx.runtimeEnv) return {};
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { env: { ...env, ...ctx.runtimeEnv } };
}

export function createCodexRunner(): Runner {
  const abortController = new AbortController();
  const signal = abortController.signal;
  let cancelled = false;
  let thread: Thread | undefined;
  let sessionId: string | undefined;

  const threadOptions = (ctx: RunnerContext): ThreadOptions => ({
    workingDirectory: ctx.workspace.worktreePath,
    sandboxMode: "workspace-write",
    skipGitRepoCheck: true,
    ...(ctx.config.model ? { model: ctx.config.model } : {}),
  });

  const openThread = (ctx: RunnerContext): Thread => {
    // Brokered inference env (DHK-89), for a managed / Docker-isolated node with no ambient login.
    const codex = new Codex(runtimeEnvOptions(ctx));
    const t = ctx.sessionId ? codex.resumeThread(ctx.sessionId, threadOptions(ctx)) : codex.startThread(threadOptions(ctx));
    thread = t;
    return t;
  };

  /** Stream one Codex turn's events through the mappers; returns whether the turn failed. */
  const pumpTurn = async (
    events: AsyncGenerator<ThreadEvent>,
    emit: (e: EmittableEvent, rawRef?: string) => void,
    ctx: RunnerContext,
    suppressStageExit: boolean,
  ): Promise<boolean> => {
    let failed = false;
    for await (const ev of events) {
      const rawRef = ctx.writeRaw?.(ev);
      const { events: mapped } = mapCodexEvent(ev);
      for (const e of mapped) {
        if (suppressStageExit && e.type === "state") continue;
        emit(e, rawRef);
      }
      if (ev.type === "thread.started") sessionId = ev.thread_id;
      if (ev.type === "turn.failed") failed = true;
    }
    return failed;
  };

  const captureThreadId = (t: Thread): void => {
    if (t.id) sessionId = t.id;
  };

  return {
    runtime: "codex",

    async runBatch(ctx, onTrace) {
      // the Codex SDK has no MCP support (ThreadOptions has no MCP field), so a stage's
      // declared brokered MCP servers cannot be wired here. Log and proceed (not an error); use a
      // claude-code stage for MCP-backed work.
      if (ctx.config.mcpServers && ctx.config.mcpServers.length > 0) {
        process.stderr.write("codex-adapter: MCP servers not supported on Codex; ignoring\n");
      }
      const emit = makeEmit("codex", onTrace);
      const t = openThread(ctx);
      let status: JobStatus = "ok";
      try {
        const { events } = await t.runStreamed(resolveStagePrompt(ctx), { signal });
        if (await pumpTurn(events, emit, ctx, false)) status = "fail";
      } catch (e) {
        if (!cancelled) emit({ type: "error", kind: "runtime_error", message: (e as Error).message });
        status = "fail";
      }
      captureThreadId(t);
      if (cancelled) status = "fail";
      return { status, ...(sessionId ? { sessionId } : {}) };
    },

    async runInteractive(ctx, turns, onTrace) {
      const emit = makeEmit("codex", onTrace);
      const t = openThread(ctx);
      // Default to `either`, not `gate` (DHK-363): with `gate` the stage-complete tool is disabled,
      // so an interactive stage can only end `ok` if the human happens to type "allow"/"approve" -
      // a keyword nothing tells them about. A stage that omits `exit` must still be completable.
      const exit = ctx.config.exit ?? "either";
      if (exit === "tool" || exit === "either") {
        // Tool-exit needs an in-process MCP tool wired into the Codex thread, which is
        // unproven and not required by M4 acceptance (Codex acceptance is batch-only).
        // Degrade to gate exit; M5 can revisit if Codex interactive tool-exit is needed.
        process.stderr.write("codex-adapter: interactive tool-exit not supported in M4; using gate exit\n");
      }

      const humanIter = turns[Symbol.asyncIterator]();
      const { firstReplyMs, idleMs } = interactiveIdleWindows(ctx);
      let awaitingFirstReply = true;
      let exited: "gate" | "timeout" | "cancelled" = "gate";
      let pending = humanIter.next();
      try {
        // Self-seed the opening turn: the stage's trigger text rides in `issueContext`, not
        // as a queued human turn, so open the interview ourselves rather than idling to a timeout.
        // Codex carries no system instruction, so seed the full resolved prompt (as the batch path does).
        const seed = await t.runStreamed(interactiveSeedText(ctx, false), { signal });
        await pumpTurn(seed.events, emit, ctx, true);
        for (;;) {
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
          const { events } = await t.runStreamed(texts.join("\n"), { signal });
          await pumpTurn(events, emit, ctx, true);
        }
      } catch (e) {
        if (!cancelled) emit({ type: "error", kind: "runtime_error", message: (e as Error).message });
        exited = cancelled ? "cancelled" : "gate";
      }

      let status: JobStatus = "ok";
      let summary = "";
      if (exited === "gate") {
        try {
          const turn = await t.run(SUMMARISE_PROMPT, { signal });
          summary = (turn.finalResponse ?? "").trim() || "(no summary produced)";
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
      captureThreadId(t);
      return { status, summary, ...(sessionId ? { sessionId } : {}) } as Omit<JobResult, "jobId">;
    },

    async summarise(ctx) {
      // Engine-owned handoff turn: resume the warm thread for one constrained turn. It must
      // not emit trace events (not the agent's stage work).
      if (!thread) return "(no summary: thread not established)";
      try {
        const turn = await thread.run(SUMMARISE_PROMPT, { signal });
        captureThreadId(thread);
        return (turn.finalResponse ?? "").trim() || "(no summary produced)";
      } catch (e) {
        return `(summary unavailable: ${(e as Error).message})`;
      }
      // ctx is unused: the warm thread already carries the worktree + model.
    },

    async cancel() {
      if (cancelled) return;
      cancelled = true;
      abortController.abort();
    },
  };
}
