/**
 * A mock Runner for M3. It implements the contract `Runner` without any LLM: a
 * batch run emits a deterministic thought -> action -> observation -> response
 * trace and returns `ok`. This lets the edge's stage runner, worktree, trace
 * producer, policy hook, and the whole hub<->edge path be exercised end-to-end
 * before M4 adds the real Claude and Pi adapters behind the same interface.
 *
 * The single `action` it emits carries the stage's first configured tool (else
 * "shell"), so a policy that denies that tool can be exercised in tests.
 */
import type { HumanTurn, JobResult, Runner, RunnerContext, TraceEvent } from "@dahrk/contracts";

const nowIso = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A turn whose text is this sentinel mimics the agent calling dahrk_stage_complete (tool exit). */
const COMPLETE_SENTINEL = "__complete__";

export function createMockRunner(runtime: Runner["runtime"]): Runner {
  let cancelled = false;
  return {
    runtime,

    async runBatch(ctx: RunnerContext, onTrace: (event: TraceEvent) => void) {
      const tool = ctx.config.tools?.[0] ?? "shell";
      const toolUseId = "mock-tool-1";
      const events: TraceEvent[] = [
        { seq: 0, runtime, type: "thought", ts: nowIso(), text: "mock: planning the stage" },
        { seq: 1, runtime, type: "action", ts: nowIso(), tool, toolUseId, input: { note: "mock action" } },
        { seq: 2, runtime, type: "observation", ts: nowIso(), toolUseId, output: { ok: true } },
        { seq: 3, runtime, type: "response", ts: nowIso(), text: "mock: stage complete" },
      ];
      for (const event of events) onTrace(event);
      // Optional delay so tests can SIGKILL the edge mid-stage (crash recovery).
      const delayMs = Number(process.env.DAHRK_MOCK_DELAY_MS ?? process.env.SKAKEL_MOCK_DELAY_MS ?? 0);
      if (delayMs > 0) await sleep(delayMs);
      // Optional deterministic per-stage cost so the offline harness can drive cost_budget (M6).
      const costUsd = Number(process.env.DAHRK_MOCK_COST_USD ?? process.env.SKAKEL_MOCK_COST_USD ?? 0);
      return { status: cancelled ? "fail" : "ok", ...(costUsd > 0 ? { costUsd } : {}) };
    },

    async runInteractive(
      _ctx: RunnerContext,
      turns: AsyncIterable<HumanTurn>,
      onTrace: (event: TraceEvent) => void,
    ) {
      // Deterministic, credential-free interactive drive so the hub harness can exercise the
      // full prompted -> turn relay -> runInteractive path. Emit a thought + response per turn;
      // exit on the COMPLETE sentinel (tool exit) or when the turn stream ends (gate exit).
      let count = 0;
      let last = "";
      let toolExit = false;
      for await (const turn of turns) {
        if (turn.text === COMPLETE_SENTINEL) {
          toolExit = true;
          break;
        }
        count++;
        last = turn.text;
        onTrace({ seq: 0, runtime, type: "thought", ts: nowIso(), text: `mock: heard "${turn.text}"` });
        onTrace({ seq: 0, runtime, type: "response", ts: nowIso(), text: `mock: ack ${count}` });
      }
      if (cancelled) {
        return { status: "fail", summary: "mock interactive: cancelled" } as Omit<JobResult, "jobId">;
      }
      const summary = toolExit
        ? `mock interactive complete (tool) after ${count} turns`
        : `mock interactive complete (gate) after ${count} turns: ${last}`;
      return { status: "ok", summary } as Omit<JobResult, "jobId">;
    },

    async summarise(ctx: RunnerContext) {
      // The mock summary is deterministic so the offline hub harness stays reproducible.
      return `mock summary: ${ctx.config.runtime} stage complete`;
    },

    async cancel() {
      cancelled = true;
    },
  };
}
