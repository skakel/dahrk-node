/**
 * M4 go-live smoke (credentials-gated; mirrors the M0 spikes). NOT part of CI. It exercises
 * the real adapters end to end against a throwaway worktree:
 *   1. a Claude BATCH stage runs to a terminal result, writes a valid trace, and produces a
 *      real engine-owned summary (runner.summarise);
 *   2. an interactive Claude stage takes multi-turn input and exits via BOTH gate and tool;
 *   3. (opt-in) a Codex stage writes the SAME normalised envelope.
 *
 * Claude Code is the PRIMARY runtime and the default of this smoke. Codex is opt-in and
 * NON-BLOCKING: a Codex auth/run failure is warned, never asserted, so it cannot block the
 * go-live check while Codex auth is parked.
 *
 * Run: `pnpm --filter @dahrk/executor-worktree spike/live`  (Claude + interactive)
 * Include Codex: `DAHRK_LIVE_RUNTIMES=claude,interactive,codex pnpm --filter ... spike/live`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { AgentConfig, HumanTurn, RunnerContext, TraceEvent, TraceMeta, WorkspaceRef } from "@dahrk/contracts";
import { createClaudeRunner, createCodexRunner } from "../src/index.js";
import { createTraceWriter } from "../src/trace-writer.js";

const here = dirname(fileURLToPath(import.meta.url));
const traceSchema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve("@dahrk/contracts"))), "..", "schemas", "trace.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(traceSchema);
const validateEvent = ajv.compile({ $ref: "https://skakel.io/schemas/trace.schema.json#/$defs/event" });

const want = (name: string): boolean => {
  // Claude Code is primary: the default set is Claude batch + interactive. Codex is opt-in.
  const list = (process.env.DAHRK_LIVE_RUNTIMES ?? process.env.SKAKEL_LIVE_RUNTIMES ?? "claude,interactive").split(",").map((s) => s.trim());
  return list.includes(name);
};

/** A throwaway git worktree so the runtimes have a real repo to operate in. */
function makeWorktree(): WorkspaceRef {
  const worktreePath = mkdtempSync(join(tmpdir(), "dahrk-live-wt-"));
  execFileSync("git", ["init", "-q"], { cwd: worktreePath });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: worktreePath,
    env: { ...process.env, GIT_AUTHOR_NAME: "skakel", GIT_AUTHOR_EMAIL: "s@skakel.io", GIT_COMMITTER_NAME: "skakel", GIT_COMMITTER_EMAIL: "s@skakel.io" },
  });
  return { repoId: "live", gitUrl: "https://example.invalid/live.git", repo: "live", baseBranch: "main", worktreePath, scratchPath: join(worktreePath, ".dahrk", "scratch") };
}

const metaFor = (runtime: AgentConfig["runtime"], stageId: string): TraceMeta => ({
  tenantId: "t_live",
  runId: "run_live",
  stageId,
  jobId: `job_${stageId}`,
  attempt: 1,
  runtime,
  configDigest: "sha256:live",
  startedAt: new Date().toISOString(),
});

async function* turnStream(turns: Array<{ text: string; afterMs?: number }>): AsyncIterable<HumanTurn> {
  for (const t of turns) {
    if (t.afterMs) await new Promise((r) => setTimeout(r, t.afterMs));
    yield { text: t.text, ts: new Date().toISOString() };
  }
}

async function main(): Promise<void> {
  if (want("claude")) {
    console.log("\n[1] Claude batch stage");
    const ws = makeWorktree();
    const config: AgentConfig = {
      runtime: "claude-code",
      model: process.env.DAHRK_LIVE_MODEL ?? process.env.SKAKEL_LIVE_MODEL ?? "haiku",
      prompt: "Create a file scratch-note.txt containing the single word DONE, then reply with one short sentence confirming it.",
      interaction: "batch",
    };
    const writer = createTraceWriter(ws.scratchPath, metaFor("claude-code", "build"));
    const events: TraceEvent[] = [];
    const ctx: RunnerContext = { config, workspace: ws, writeRaw: writer.writeRaw };
    const runner = createClaudeRunner();
    const result = await runner.runBatch(ctx, (e) => {
      events.push(e);
      writer.append(e);
    });
    const summary = await runner.summarise(ctx);
    writer.finalise({ status: result.status, endedAt: new Date().toISOString(), ...(result.sessionId ? { sessionId: result.sessionId } : {}) });
    for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
    console.log(`  status=${result.status}; events=${events.length}; summary="${summary}"`);
    assert.equal(result.status, "ok", "Claude batch stage should succeed");
    assert.ok(summary && !summary.startsWith("(no summary"), "a real summary was produced");
  }

  if (want("interactive")) {
    for (const exit of ["gate", "tool"] as const) {
      console.log(`\n[2] Interactive Claude stage (exit=${exit})`);
      const ws = makeWorktree();
      const config: AgentConfig = {
        runtime: "claude-code",
        model: process.env.DAHRK_LIVE_MODEL ?? process.env.SKAKEL_LIVE_MODEL ?? "haiku",
        prompt:
          "You are an interactive planning stage. Converse in one short sentence per turn. " +
          "When the human says the plan is agreed, call dahrk_stage_complete with a one-sentence summary.",
        interaction: "interactive",
        exit,
      };
      const writer = createTraceWriter(ws.scratchPath, metaFor("claude-code", `plan-${exit}`));
      const events: TraceEvent[] = [];
      const ctx: RunnerContext = { config, workspace: ws, writeRaw: writer.writeRaw };
      const runner = createClaudeRunner();
      const turns =
        exit === "tool"
          ? [{ text: "Let us plan a refactor." }, { text: "The plan is agreed; mark the stage complete.", afterMs: 200 }]
          : [{ text: "Let us plan a refactor." }, { text: "What is the first step?", afterMs: 200 }];
      const result = await runner.runInteractive(ctx, turnStream(turns), (e) => {
        events.push(e);
        writer.append(e);
      });
      writer.finalise({ status: result.status, endedAt: new Date().toISOString() });
      for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
      console.log(`  status=${result.status}; events=${events.length}; summary="${result.summary}"`);
      assert.equal(result.status, "ok", `interactive ${exit} stage should succeed`);
      assert.ok(result.summary.length > 0, "a summary was produced");
    }
  }

  if (want("codex")) {
    console.log("\n[3] Codex batch stage (same envelope; opt-in, non-blocking)");
    const ws = makeWorktree();
    const config: AgentConfig = {
      runtime: "codex",
      prompt: "List the files in the working directory and reply with one short sentence.",
      interaction: "batch",
    };
    const writer = createTraceWriter(ws.scratchPath, metaFor("codex", "build"));
    const events: TraceEvent[] = [];
    const ctx: RunnerContext = { config, workspace: ws, writeRaw: writer.writeRaw };
    const runner = createCodexRunner();
    const result = await runner.runBatch(ctx, (e) => {
      events.push(e);
      writer.append(e);
    });
    const summary = await runner.summarise(ctx);
    writer.finalise({ status: result.status, endedAt: new Date().toISOString() });
    // The envelope must still validate even on an auth failure (errors are normalised events).
    for (const e of events) assert.ok(validateEvent(e), `schema: ${JSON.stringify(validateEvent.errors)}`);
    console.log(`  status=${result.status}; events=${events.length}; summary="${summary}"`);
    // Non-blocking: Codex auth is parked. Warn on failure rather than failing the smoke.
    if (result.status !== "ok") {
      console.log("  WARN: Codex stage did not succeed - Codex auth is parked, not blocking go-live.");
    }
  }

  console.log("\nLIVE SMOKE OK");
}

main().catch((err) => {
  console.error("\nLIVE SMOKE FAIL:", err);
  process.exit(1);
});
