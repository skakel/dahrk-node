/**
 * The stage runner streams its normalised trace to the observability sink as it runs
 * and finalises at stage exit. This exercises a real worktree (git) + the mock runner
 * and a capturing TraceSink, asserting: every event is streamed with a contiguous seq,
 * the finalised frame carries the authoritative count + archive key, and heavy payloads
 * are offered to the sink for upload. No hub, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobProgress, JobRequest, PushJob, Runner, RunnerContext, TraceEvent, TraceMeta } from "@dahrk/contracts";
import { createGitService, createMockRunner } from "@dahrk/executor-worktree";
import {
  createStageRunner,
  resolveStageArtifact,
  runtimeUsesMcpGateway,
  type BlobPutRequestArgs,
  type TraceSink,
} from "../src/stage-runner.js";

function initRepo(dir: string): void {
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  execFileSync("sh", ["-c", "echo hello > README.md"], { cwd: dir });
  git("add", ".");
  git("commit", "-m", "init");
}

test("stage runner streams the trace and finalises with count + archive key", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "wt");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const streamed: TraceEvent[] = [];
  const uploads: BlobPutRequestArgs[] = [];
  let finalised: { meta: TraceMeta; eventCount: number; archiveKey?: string } | undefined;
  const sink: TraceSink = {
    event: (f) => void streamed.push(f.event),
    finalised: (f) => void (finalised = { meta: f.meta, eventCount: f.eventCount, ...(f.archiveKey ? { archiveKey: f.archiveKey } : {}) }),
    requestBlobUrl: async (req) => {
      uploads.push(req);
      return { key: `key/${req.slot}/${req.sha256}` }; // no url -> the runner skips the PUT
    },
  };

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: worktrees, mirrorsDir: join(root, "mir") }),
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-sr-1",
    stageId: "build",
    jobId: "job-sr-1",
    awakeableId: "awk-1",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    // gitUrl is the local source repo: the edge clones it on demand into the mirror cache.
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok");

    // attempt-start + mock (thought, action, observation, response) + stage-exit = 6.
    assert.equal(streamed.length, 6, "every written event is streamed");
    assert.equal(streamed[0]!.type, "state");
    assert.equal((streamed[0] as { event: string }).event, "attempt-start");
    assert.equal((streamed[streamed.length - 1] as { event: string }).event, "stage-exit");
    // Seqs are contiguous and writer-assigned (0..n-1), so the hub can detect gaps.
    assert.deepEqual(streamed.map((e) => e.seq), [0, 1, 2, 3, 4, 5]);

    assert.ok(finalised, "a finalised frame is sent");
    assert.equal(finalised.eventCount, 6, "finalised count matches the events written");
    assert.equal(finalised.meta.status, "ok");
    assert.equal(finalised.archiveKey, `key/archive/${finalised.archiveKey?.split("/").pop()}`);

    // The finalised trace.jsonl archive is always offered for upload.
    assert.ok(uploads.some((u) => u.slot === "archive"), "the archive is offered to object storage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a telemetry-only Job (no workspaceRef) runs in scratch with no clone attempted", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-meta-"));
  const scratchRoot = join(root, "scratch");

  const streamed: TraceEvent[] = [];
  let finalised: { meta: TraceMeta; eventCount: number } | undefined;
  const sink: TraceSink = {
    event: (f) => void streamed.push(f.event),
    finalised: (f) => void (finalised = { meta: f.meta, eventCount: f.eventCount }),
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A git service whose clone path throws if ever entered: proof that no worktree is built for a
  // telemetry-only run. Only createWorktree is fatal; the (unused) teardown is a no-op.
  const noCloneGit = {
    createWorktree: () => assert.fail("createWorktree must not be called for a telemetry-only run"),
    teardownWorktree: async () => undefined,
  };

  const runner = createStageRunner({
    gitService: noCloneGit as never,
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
    scratchRoot,
  });

  // No workspaceRef: the meta-loop run carries no customer repo, only injected telemetry.
  const job: JobRequest = {
    tenantId: "t_platform",
    runId: "run-meta-1",
    stageId: "diagnose",
    jobId: "job-meta-1",
    awakeableId: "awk-meta",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    issueContext: "# Telemetry\n\nRun health: degraded.",
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok", "the stage completes against injected telemetry + scratch");

    // The injected telemetry was written to the run's scratch dir, no git involved.
    const issuePath = join(scratchRoot, "run-meta-1", ".dahrk", "scratch", "issue.md");
    assert.ok(existsSync(issuePath), "the injected issueContext is written to scratch");
    assert.equal(readFileSync(issuePath, "utf8"), job.issueContext);

    // The trace still streams and finalises (attempt-start ... stage-exit).
    assert.equal(streamed[0]!.type, "state");
    assert.equal((streamed[0] as { event: string }).event, "attempt-start");
    assert.equal((streamed[streamed.length - 1] as { event: string }).event, "stage-exit");
    assert.ok(finalised, "a finalised frame is sent");
    assert.equal(finalised.meta.status, "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tenant-bound node refuses a Job for another tenant (no worktree built)", async () => {
  // A git service whose clone path throws if ever entered: proof the guard short-circuits BEFORE the
  // worktree is created for a mismatched tenant.
  const noCloneGit = {
    createWorktree: () => assert.fail("createWorktree must not be called for a refused Job"),
    teardownWorktree: async () => undefined,
  };
  const runner = createStageRunner({
    gitService: noCloneGit as never,
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
    tenantId: "t_platform", // this node is bound to the platform tenant.
  });

  const job: JobRequest = {
    tenantId: "t_default", // a customer-tenant Job that should never have been dispatched here.
    runId: "run-mismatch-1",
    stageId: "diagnose",
    jobId: "job-mismatch-1",
    awakeableId: "awk-mismatch",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    issueContext: "# Telemetry",
    timeout: 60,
  };

  const result = await runner.runJob(job);
  assert.equal(result.status, "fail");
  assert.match(result.summary ?? "", /refuses a job for tenant "t_default"/);
});

test("a matching-tenant Job runs normally under a tenant-bound node", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-tenant-"));
  const scratchRoot = join(root, "scratch");
  const runner = createStageRunner({
    gitService: {
      createWorktree: () => assert.fail("telemetry-only job needs no clone"),
      teardownWorktree: async () => undefined,
    } as never,
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
    tenantId: "t_platform",
    scratchRoot,
  });

  // Telemetry-only (no workspaceRef) so the run needs no real repo; the tenant matches the node's.
  const job: JobRequest = {
    tenantId: "t_platform",
    runId: "run-match-1",
    stageId: "diagnose",
    jobId: "job-match-1",
    awakeableId: "awk-match",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    issueContext: "# Telemetry",
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok", "a same-tenant Job passes the guard and runs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retention tears down old run worktrees and keeps the newest", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-ret-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "wt");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const torn: string[] = [];
  const gitService = createGitService({ worktreesDir: worktrees, mirrorsDir: join(root, "mir") });
  const wrapped = {
    ...gitService,
    teardownWorktree: async (ref: { worktreePath: string }) => {
      torn.push(ref.worktreePath);
      return gitService.teardownWorktree(ref as never);
    },
  };

  const runner = createStageRunner({
    gitService: wrapped as never,
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
    retention: { maxRuns: 2 },
  });

  const mkJob = (n: number): JobRequest => ({
    tenantId: "t_default",
    runId: `run-${n}`,
    stageId: "build",
    jobId: `job-${n}`,
    awakeableId: `awk-${n}`,
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
  });

  try {
    // Three sequential runs with maxRuns=2: the first run's worktree is pruned.
    await runner.runJob(mkJob(1));
    await runner.runJob(mkJob(2));
    assert.equal(torn.length, 0, "within the limit, nothing is pruned");
    await runner.runJob(mkJob(3));
    assert.equal(torn.length, 1, "exceeding maxRuns prunes the least-recently-used run");
    assert.ok(torn[0]!.includes("run-1"), "the oldest run (run-1) is the one torn down");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stage that exceeds its timeout is killed and marked `timeout` (job.timeout kill)", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-to-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const sink: TraceSink = {
    event: () => undefined,
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A runner whose run hangs until cancel() aborts it - exactly how the real adapters behave on
  // AbortController.abort(): runBatch resolves gracefully with a non-ok status, it does not throw.
  // The stage runner's wall-clock kill must fire cancel() at job.timeout and force status `timeout`.
  const makeHangingRunner = (runtime: Runner["runtime"]): Runner => {
    let release: (() => void) | undefined;
    const aborted = new Promise<void>((r) => (release = r));
    return {
      runtime,
      async runBatch() {
        await aborted;
        return { status: "fail" };
      },
      async runInteractive() {
        await aborted;
        return { status: "fail", summary: "cancelled" };
      },
      async summarise() {
        return "n/a";
      },
      async cancel() {
        release?.();
      },
    };
  };

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeHangingRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-sr-to",
    stageId: "build",
    jobId: "job-sr-to-1",
    awakeableId: "awk-to",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 0.05, // 50ms wall-clock; the hanging runner only completes when the kill fires cancel()
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "timeout", "the stage is killed at its timeout and reported `timeout`");
    assert.equal(result.failureClass, "harness", "a harness-owned wall-clock kill is billed harness, not agent (DHK-569)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a batch stage that streams no output for `stallMs` is cancelled and marked `timeout` (stall watchdog)", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-stall-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const sink: TraceSink = {
    event: () => undefined,
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A runner that hangs producing no trace at all - the orphaned-subprocess case. With no wall clock
  // (job.timeout absent), only the batch output-idle watchdog can end it: it fires cancel() after
  // `stallMs` of silence, and the stage is reported `timeout` with a distinct `stalled` summary.
  const makeSilentRunner = (runtime: Runner["runtime"]): Runner => {
    let release: (() => void) | undefined;
    const aborted = new Promise<void>((r) => (release = r));
    return {
      runtime,
      async runBatch() {
        await aborted;
        return { status: "fail" };
      },
      async runInteractive() {
        await aborted;
        return { status: "fail" };
      },
      async summarise() {
        return "n/a";
      },
      async cancel() {
        release?.();
      },
    };
  };

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeSilentRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-sr-stall",
    stageId: "build",
    jobId: "job-sr-stall-1",
    awakeableId: "awk-stall",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    // No `timeout`: the wall clock is opt-in and absent here, so the stall watchdog is the only guard.
  };

  const prev = process.env.DAHRK_BATCH_STALL_MS;
  process.env.DAHRK_BATCH_STALL_MS = "50"; // 50ms of silence -> stall
  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "timeout", "a silent batch stage is cancelled by the stall watchdog");
    assert.match(result.summary ?? "", /stalled \(no output for/, "the summary marks it a stall, not a plain timeout");
    assert.equal(result.failureClass, "harness", "a harness-owned stall kill is billed harness, not agent (DHK-569)");
  } finally {
    if (prev === undefined) delete process.env.DAHRK_BATCH_STALL_MS;
    else process.env.DAHRK_BATCH_STALL_MS = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a batch stage that keeps streaming resets the stall watchdog and is never cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-nostall-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const sink: TraceSink = {
    event: () => undefined,
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A runner that streams a `thought` every 20ms for ~200ms, then finishes ok. Every event bumps the
  // 50ms watchdog, so no single gap exceeds the window and the stage is never cancelled - proving an
  // actively-working batch stage outlives a stall window many times its own length.
  const makeStreamingRunner = (runtime: Runner["runtime"]): Runner => ({
    runtime,
    async runBatch(_ctx: RunnerContext, onTrace: (event: TraceEvent) => void) {
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 20));
        onTrace({ seq: i, ts: new Date().toISOString(), type: "thought", runtime, text: `tick ${i}` });
      }
      return { status: "ok" };
    },
    async runInteractive() {
      return { status: "ok" };
    },
    async summarise() {
      return "done";
    },
    async cancel() {},
  });

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeStreamingRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-sr-nostall",
    stageId: "build",
    jobId: "job-sr-nostall-1",
    awakeableId: "awk-nostall",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
  };

  const prev = process.env.DAHRK_BATCH_STALL_MS;
  process.env.DAHRK_BATCH_STALL_MS = "50"; // shorter than the total run, longer than each 20ms gap
  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok", "a continuously-streaming batch stage is never cancelled by the watchdog");
  } finally {
    if (prev === undefined) delete process.env.DAHRK_BATCH_STALL_MS;
    else process.env.DAHRK_BATCH_STALL_MS = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Job's runtimeEnv is threaded onto the runner ctx (injection boundary)", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-rtenv-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const sink: TraceSink = {
    event: () => undefined,
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A runner that records the ctx it is handed, so we can assert the stage runner set runtimeEnv from
  // the Job (the adapter would apply it as the inference process env; here we only check the seam).
  const seen: RunnerContext[] = [];
  const makeCapturingRunner = (runtime: Runner["runtime"]): Runner => ({
    runtime,
    async runBatch(ctx) {
      seen.push(ctx);
      return { status: "ok" };
    },
    async runInteractive(ctx) {
      seen.push(ctx);
      return { status: "ok", summary: "n/a" };
    },
    async summarise() {
      return "n/a";
    },
    async cancel() {},
  });

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeCapturingRunner,
    rules: [],
    sendProgress: () => undefined,
    trace: sink,
  });

  const mkJob = (jobId: string, runtimeEnv?: Record<string, string>): JobRequest => ({
    tenantId: "t_default",
    runId: "run-sr-rtenv",
    stageId: "build",
    jobId,
    awakeableId: "awk-rtenv",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
    ...(runtimeEnv ? { runtimeEnv } : {}),
  });

  try {
    await runner.runJob(mkJob("job-rtenv-1", { ANTHROPIC_API_KEY: "sk-test", PI_MODEL: "claude-opus-4-8" }));
    assert.deepEqual(seen[0]?.runtimeEnv, { ANTHROPIC_API_KEY: "sk-test", PI_MODEL: "claude-opus-4-8" });

    await runner.runJob(mkJob("job-rtenv-2")); // no runtimeEnv -> absent on ctx (ambient node)
    assert.equal(seen[1]?.runtimeEnv, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude-style runner authorization denies a policy-blocked tool before execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-auth-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const streamed: TraceEvent[] = [];
  const progress: JobProgress[] = [];
  const sink: TraceSink = {
    event: (f) => void streamed.push(f.event),
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  const makeAuthorizingRunner = (runtime: Runner["runtime"]): Runner => ({
    runtime,
    async runBatch(ctx) {
      const verdict = (ctx as RunnerContext & { authorizeToolUse?: (tool: string, input: unknown) => { verdict: string } })
        .authorizeToolUse?.("Bash", { command: "sudo true" });
      assert.equal(verdict?.verdict, "deny");
      return { status: "ok" };
    },
    async runInteractive() {
      return { status: "ok", summary: "n/a" };
    },
    async summarise() {
      return "n/a";
    },
    async cancel() {},
  });

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeAuthorizingRunner,
    rules: [],
    sendProgress: (p) => void progress.push(p),
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-auth-1",
    stageId: "build",
    jobId: "job-auth-1",
    awakeableId: "awk-auth",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch" },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    policies: [{ shell_guard: { mode: "deny" } }],
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok");
    assert.match(result.summary ?? "", /tool actions were blocked/);
    assert.ok(streamed.some((e) => e.type === "state" && (e as { event?: string }).event === "policy-deny"));
    assert.ok(!streamed.some((e) => e.type === "action" && e.tool === "Bash"), "the denied Bash action was never emitted/executed");
    assert.ok(progress.some((p) => p.kind === "error" && /shell command blocked/.test(p.text ?? "")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated identical policy denials surface only one human-visible error (DHK-493)", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-denyspam-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const streamed: TraceEvent[] = [];
  const progress: JobProgress[] = [];
  const sink: TraceSink = {
    event: (f) => void streamed.push(f.event),
    finalised: () => undefined,
    requestBlobUrl: async (req) => ({ key: `k/${req.sha256}` }),
  };

  // A runner that attempts the SAME denied command several times, as a capped or looping agent would.
  const makeSpammingRunner = (runtime: Runner["runtime"]): Runner => ({
    runtime,
    async runBatch(ctx) {
      const authorize = (ctx as RunnerContext & { authorizeToolUse?: (tool: string, input: unknown) => { verdict: string } })
        .authorizeToolUse;
      for (let i = 0; i < 5; i++) {
        const verdict = authorize?.("Bash", { command: "sudo true" });
        assert.equal(verdict?.verdict, "deny");
      }
      return { status: "ok" };
    },
    async runInteractive() {
      return { status: "ok", summary: "n/a" };
    },
    async summarise() {
      return "n/a";
    },
    async cancel() {},
  });

  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") }),
    makeRunner: makeSpammingRunner,
    rules: [],
    sendProgress: (p) => void progress.push(p),
    trace: sink,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-denyspam-1",
    stageId: "build",
    jobId: "job-denyspam-1",
    awakeableId: "awk-denyspam",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch" },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    policies: [{ shell_guard: { mode: "deny" } }],
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok");
    // Every deny is still recorded in the trace (observability is unchanged)...
    const denyEvents = streamed.filter((e) => e.type === "state" && (e as { event?: string }).event === "policy-deny");
    assert.equal(denyEvents.length, 5, "each denied action is recorded once in the trace");
    // ...but the human-visible error frame (which becomes a Linear comment) is collapsed to one.
    const errorFrames = progress.filter((p) => p.kind === "error" && /shell command blocked/.test(p.text ?? ""));
    assert.equal(errorFrames.length, 1, "the same deny reason surfaces at most one comment per stage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact resolution rejects paths that escape the worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-artifact-"));
  const worktreePath = join(root, "worktree");
  const scratchPath = join(worktreePath, ".dahrk", "scratch");
  execFileSync("mkdir", ["-p", scratchPath]);
  initRepo(worktreePath);
  writeFileSync(join(root, "secret.md"), "outside");

  const ref = { repoId: "repo", gitUrl: "u", repo: "repo", baseBranch: "main", worktreePath, scratchPath };

  try {
    assert.equal(resolveStageArtifact(ref, "../secret.md", undefined), undefined);
    assert.equal(resolveStageArtifact(ref, undefined, { path: "../secret.md", content: "handoff" }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A recording GitService stub: enough surface for the runPush routing tests, no real git. */
function recordingGitService() {
  const calls: { method: string; branch?: string }[] = [];
  const ref = { repoId: "repo", gitUrl: "u", repo: "repo", baseBranch: "main", worktreePath: "/tmp/wt", scratchPath: "/tmp/wt/.dahrk" };
  const svc = {
    createWorktree: async (spec: { branch?: string }) => {
      calls.push({ method: "createWorktree", ...(spec.branch ? { branch: spec.branch } : {}) });
      return ref;
    },
    commitAndPush: async (_r: unknown, opts: { branch: string }) => {
      calls.push({ method: "commitAndPush", branch: opts.branch });
      return { headSha: "deadbeef1234567", pushed: true, nothingToCommit: false, commitsAhead: 1, integration: "clean" as const };
    },
    backupPush: async (_r: unknown, opts: { branch: string }) => {
      calls.push({ method: "backupPush", branch: opts.branch });
      return { headSha: "cafebabe7654321", pushed: true, nothingToCommit: false, wipRef: opts.branch };
    },
    openPrAmbient: async () => ({ prError: "not exercised" }),
    teardownWorktree: async () => undefined,
  };
  return { svc, calls };
}

const mkPushJob = (over: Partial<PushJob> & { mode?: "deliver" | "backup" }): PushJob => ({
  tenantId: "t_default",
  runId: "run-push-1",
  jobId: "job-push-1",
  awakeableId: "awk-push",
  workspaceRef: { repoId: "repo", gitUrl: "u", repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
  branch: "skakel/issue-PUSH",
  base: "main",
  message: "deliver",
  ...over,
});

test("runPush mode:backup routes to backupPush on the sticky worktree and returns wipRef", async () => {
  const { svc, calls } = recordingGitService();
  const runner = createStageRunner({ gitService: svc as never, makeRunner: createMockRunner, rules: [], sendProgress: () => undefined });

  // A first deliver push seeds the run's sticky worktree (via the createWorktree fallback).
  await runner.runPush(mkPushJob({ jobId: "job-deliver", branch: "skakel/issue-PUSH" }));
  assert.ok(calls.some((c) => c.method === "commitAndPush"), "deliver took the commitAndPush path");

  // The backup push reuses that worktree and force-preserves HEAD on the wip ref - no commitAndPush.
  const wipRef = "dahrk/wip/run-push-1";
  const before = calls.length;
  const res = await runner.runPush(mkPushJob({ jobId: "job-backup", mode: "backup", branch: wipRef, message: "preserve" }));
  const backupCalls = calls.slice(before);

  assert.equal(res.status, "ok");
  assert.equal((res as { wipRef?: string }).wipRef, wipRef, "the preserved ref is echoed back");
  assert.equal(res.pushed, true);
  assert.equal(res.headSha, "cafebabe7654321");
  assert.deepEqual(backupCalls, [{ method: "backupPush", branch: wipRef }], "only backupPush ran (no merge, no PR)");
});

test("runPush forwards a `noop` integration as a clean, non-error no-op (no PR, no conflictFiles)", async () => {
  // DHK-318: commitAndPush reports `noop` when the branch adds nothing over the base. The runner must
  // close the push as a successful no-op - status ok, nothing pushed, no PR opened, no conflictFiles -
  // so the run reaches a non-error terminal state.
  const calls: string[] = [];
  const ref = { repoId: "repo", gitUrl: "u", repo: "repo", baseBranch: "main", worktreePath: "/tmp/wt", scratchPath: "/tmp/wt/.dahrk" };
  const svc = {
    createWorktree: async () => ref,
    commitAndPush: async () => {
      calls.push("commitAndPush");
      return { headSha: "deadbeef1234567", pushed: false, nothingToCommit: true, commitsAhead: 0, integration: "noop" as const };
    },
    backupPush: async () => ({ headSha: "x", pushed: false, nothingToCommit: true, wipRef: "w" }),
    openPrAmbient: async () => {
      calls.push("openPrAmbient");
      return {};
    },
    teardownWorktree: async () => undefined,
  };
  const runner = createStageRunner({ gitService: svc as never, makeRunner: createMockRunner, rules: [], sendProgress: () => undefined });

  const res = await runner.runPush(mkPushJob({ jobId: "job-noop", openPr: { title: "t", body: "b" } }));
  assert.equal(res.status, "ok", "a no-op is a non-error terminal outcome");
  assert.equal(res.pushed, false);
  assert.equal(res.nothingToCommit, true);
  assert.equal((res as { conflictFiles?: string[] }).conflictFiles, undefined, "no conflictFiles on a no-op");
  assert.ok(!calls.includes("openPrAmbient"), "no PR is opened when nothing was delivered");
  assert.match(res.summary, /already present/);
});

test("runPush mode:backup fails truthfully when the run has no live worktree", async () => {
  const { svc, calls } = recordingGitService();
  const runner = createStageRunner({ gitService: svc as never, makeRunner: createMockRunner, rules: [], sendProgress: () => undefined });

  // No prior stage/deliver for this run, so the sticky worktree is absent. Backup must NOT re-clone the
  // branch (that would push the base tip and lose the work) - it fails, preserving nothing silently.
  const res = await runner.runPush(mkPushJob({ runId: "run-missing", jobId: "job-backup-miss", mode: "backup", branch: "dahrk/wip/run-missing" }));
  assert.equal(res.status, "fail");
  assert.match(res.summary, /no live worktree/);
  assert.equal(calls.length, 0, "neither backupPush nor createWorktree was called");
});

test("DHK-371: a job that throws before `finish` must not leave the run marked busy for ever", async () => {
  // The leak: `inFlight` was incremented at job start but only decremented inside `finish`, which a throw
  // before it (e.g. `createWorktree` failing on a stale branch claim) skipped entirely. The run then stayed
  // "busy" for the life of the process, so every reaper/retention pass keyed on `isBusy` skipped it -
  // precisely the runs that most needed collecting, and precisely the ones whose worktree was wedging the
  // next run of the same issue.
  const root = mkdtempSync(join(tmpdir(), "dahrk-busy-"));
  const repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  const gitService = createGitService({ worktreesDir: join(root, "wt"), mirrorsDir: join(root, "mir") });
  const exploding = {
    ...gitService,
    createWorktree: async () => {
      throw new Error("fatal: 'skakel/issue-DHK-1' is already used by worktree at /somewhere/stale");
    },
  };

  const runner = createStageRunner({
    gitService: exploding as never,
    makeRunner: createMockRunner,
    rules: [],
    sendProgress: () => undefined,
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-explode",
    stageId: "build",
    jobId: "job-explode",
    awakeableId: "awk-explode",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
  };

  try {
    assert.equal(runner.isBusy("run-explode"), false, "precondition: not busy before the job");
    await assert.rejects(() => runner.runJob(job), /already used by worktree/);
    assert.equal(
      runner.isBusy("run-explode"),
      false,
      "the in-flight marker is released even though the job threw before `finish`",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("action and observation progress frames carry a shared toolUseId through a parallel/deferred sequence", async () => {
  const root = mkdtempSync(join(tmpdir(), "dahrk-sr-corr-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "wt");
  execFileSync("mkdir", ["-p", repo]);
  initRepo(repo);

  // A runner mimicking parallel/deferred tools: two tool calls are issued before either result
  // arrives, and the results return out of call order (B before A). Adjacency alone would mis-pair
  // action A with observation B; only the toolUseId makes correlation robust (DHK-384). tu-A's output
  // is > PREVIEW (500) chars to prove a result is no longer clipped mid-content.
  const bigOutput = "x".repeat(2000);
  const makeInterleavedRunner = (runtime: Runner["runtime"]): Runner => ({
    runtime,
    async runBatch(_ctx: RunnerContext, onTrace: (event: TraceEvent) => void) {
      const ts = new Date().toISOString();
      const events: TraceEvent[] = [
        { seq: 0, runtime, type: "action", ts, tool: "ToolSearch", toolUseId: "tu-A", input: { q: "A" } },
        { seq: 1, runtime, type: "action", ts, tool: "Read", toolUseId: "tu-B", input: { q: "B" } },
        { seq: 2, runtime, type: "observation", ts, toolUseId: "tu-B", output: { ok: "B" } },
        { seq: 3, runtime, type: "observation", ts, toolUseId: "tu-A", output: bigOutput },
        { seq: 4, runtime, type: "response", ts, text: "done" },
      ];
      for (const event of events) onTrace(event);
      return { status: "ok" };
    },
    async runInteractive() {
      return { status: "ok", summary: "unused" };
    },
    async summarise() {
      return "mock summary";
    },
    async cancel() {},
  });

  const captured: (JobProgress & { toolUseId?: string })[] = [];
  const runner = createStageRunner({
    gitService: createGitService({ worktreesDir: worktrees, mirrorsDir: join(root, "mir") }),
    makeRunner: makeInterleavedRunner,
    rules: [],
    sendProgress: (p) => void captured.push(p),
  });

  const job: JobRequest = {
    tenantId: "t_default",
    runId: "run-corr-1",
    stageId: "build",
    jobId: "job-corr-1",
    awakeableId: "awk-corr",
    executorType: "worktree",
    agentConfig: { runtime: "claude-code", interaction: "batch", tools: ["shell"] },
    workspaceRef: { repoId: "repo", gitUrl: repo, repo: "repo", baseBranch: "main", worktreePath: "", scratchPath: "" },
    timeout: 60,
  };

  try {
    const result = await runner.runJob(job);
    assert.equal(result.status, "ok");

    const actions = captured.filter((p) => p.kind === "action");
    const observations = captured.filter((p) => p.kind === "observation");
    assert.deepEqual(actions.map((p) => p.toolUseId), ["tu-A", "tu-B"], "every action frame carries its toolUseId");
    assert.deepEqual(
      observations.map((p) => p.toolUseId),
      ["tu-B", "tu-A"],
      "every observation frame carries its toolUseId, in emission order",
    );

    // Pair by id, not adjacency: tu-A's result arrives after tu-B's, yet still resolves to action A.
    const actA = actions.find((p) => p.toolUseId === "tu-A");
    const obsA = observations.find((p) => p.toolUseId === "tu-A");
    assert.ok(actA && obsA, "both the action and observation for tu-A were emitted");
    assert.equal(obsA!.toolUseId, actA!.toolUseId, "an action and its observation share a toolUseId");

    // The 2000-char result survives whole (RESULT cap), not clipped to the 500-char PREVIEW.
    assert.equal(obsA!.text, bigOutput, "the observation result is transmitted whole, not truncated at 500");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the node MCP gateway starts for both brokered-MCP runtimes (claude-code and pi), not codex (DHK-507)", () => {
  // The gateway holds the brokered token and injects it upstream; a runtime with no MCP client can
  // never route through it. Claude consumes brokered MCP via the SDK, Pi via its extension bridge;
  // Codex has no MCP in its SDK, so a proxy for it would be dead weight.
  assert.equal(runtimeUsesMcpGateway("claude-code"), true);
  assert.equal(runtimeUsesMcpGateway("pi"), true);
  assert.equal(runtimeUsesMcpGateway("codex"), false);
});
