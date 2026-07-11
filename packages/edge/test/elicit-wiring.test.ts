/**
 * DHK-344 edge wiring: an interactive stage that raises an AskUserQuestion elicitation reaches the hub
 * as an `elicit` wire frame. A fake runner drives `ctx.emitElicit`; the stage runner must relay it to
 * `deps.sendElicit` keyed by the job, and must NOT expose `emitElicit` when no sink is wired (ambient
 * nodes stay unaffected). The block/reply half is covered by elicit-router.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElicitChoice, ElicitQuestion, JobRequest, Runner, RunnerContext } from "@dahrk/contracts";
import { createGitService } from "@dahrk/executor-worktree";
import { createStageRunner } from "../src/stage-runner.js";

function initRepo(dir: string): void {
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  execFileSync("sh", ["-c", "echo hello > README.md"], { cwd: dir });
  git("add", ".");
  git("commit", "-m", "init");
}

type ElicitFrame = { jobId: string; prompt: string; options: ElicitChoice[]; multiSelect?: boolean };
type ElicitAware = RunnerContext & { emitElicit?: (q: ElicitQuestion) => void };

const interactiveJob = (repo: string, jobId: string): JobRequest => ({
  tenantId: "t_default",
  runId: "run-elicit",
  stageId: "refine",
  jobId,
  awakeableId: "awk-elicit",
  executorType: "worktree",
  agentConfig: { runtime: "claude-code", interaction: "interactive", tools: ["shell"] },
  workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
  timeout: 60,
});

test("an interactive AskUserQuestion is relayed to the hub as an elicit frame keyed by job", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-elicit-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const question: ElicitQuestion = {
    prompt: "Which deliverable for DHK-89?\n\n- Audit: close gaps\n- Proof: document it",
    options: [
      { label: "Audit", value: "Audit" },
      { label: "Proof", value: "Proof" },
    ],
    multiSelect: true,
  };

  const frames: ElicitFrame[] = [];
  const makeElicitingRunner = (runtime: Runner["runtime"]): Runner => ({
    runtime,
    async runBatch() {
      return { status: "ok" };
    },
    async runInteractive(ctx) {
      (ctx as ElicitAware).emitElicit?.(question);
      return { status: "ok", summary: "asked the human" };
    },
    async summarise() {
      return "n/a";
    },
    async cancel() {},
  });

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeElicitingRunner,
    rules: [],
    sendProgress: () => undefined,
    sendElicit: (f) => void frames.push(f),
  });

  try {
    const result = await runner.runJob(interactiveJob(repo, "job-elicit-1"));
    assert.equal(result.status, "ok");
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], {
      jobId: "job-elicit-1",
      prompt: question.prompt,
      options: question.options,
      multiSelect: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitElicit is absent when no elicit sink is wired (ambient node stays unaffected)", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-elicit-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  let seenEmitElicit: unknown = "unset";
  const makeProbingRunner = (runtime: Runner["runtime"]): Runner => ({
    runtime,
    async runBatch() {
      return { status: "ok" };
    },
    async runInteractive(ctx) {
      seenEmitElicit = (ctx as ElicitAware).emitElicit;
      return { status: "ok", summary: "n/a" };
    },
    async summarise() {
      return "n/a";
    },
    async cancel() {},
  });

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeProbingRunner,
    rules: [],
    sendProgress: () => undefined,
    // no sendElicit
  });

  try {
    await runner.runJob(interactiveJob(repo, "job-elicit-2"));
    assert.equal(seenEmitElicit, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
