/**
 * The stage runner: maps one Job to one runner invocation in a real git worktree,
 * streams progress, writes the normalised trace, evaluates policy around tool
 * actions and at stage entry, runs the R4 stage-exit hooks, and reports a result
 * keyed by jobId. No LLM here - control flow is the engine's; inference (M4) lives
 * inside the Runner. The worktree is created once per run and reused (sticky owner).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ElicitChoice,
  ElicitQuestion,
  HumanTurn,
  JobProgress,
  JobRequest,
  JobResult,
  JobStatus,
  PushJob,
  PushResult,
  Runner,
  RunnerContext,
  TraceEvent,
  TraceMeta,
  WorkspaceRef,
} from "@dahrk/contracts";
import type { PolicyOutcome } from "@dahrk/contracts";
import { attachedDocBasename } from "@dahrk/contracts";
import {
  createTraceWriter,
  createWorktreeReaper,
  ManagedMailbox,
  overlayComponents,
  resolveMirrorsDir,
  type GitService,
  type PackCache,
  type ReapReport,
} from "@dahrk/executor-worktree";
import { buildRules } from "./builtins.js";
import { computeFsRoots } from "./fs-roots.js";
import { createNodeLogger, type NodeLogger } from "./logger.js";
import { evaluatePolicies, type PolicyRule } from "./policy.js";
import { startMcpGateway, type McpGateway } from "./mcp-gateway.js";

/** Arguments for requesting a presigned upload of a heavy trace payload. */
export interface BlobPutRequestArgs {
  tenantId: string;
  runId: string;
  stageId: string;
  attempt: number;
  sha256: string;
  size: number;
  contentType?: string;
  slot: "blob" | "archive";
}

/** The observability trace sink: stream events to the hub as the stage runs, upload heavy
 *  payloads via hub-minted presigned URLs, and finalise at stage exit. Implemented by the
 *  WebSocket client; absent in tests (the stage still runs and writes its local trace). */
export interface TraceSink {
  event(frame: {
    runId: string;
    stageId: string;
    attempt: number;
    tenantId: string;
    event: TraceEvent;
  }): void;
  finalised(frame: {
    runId: string;
    stageId: string;
    attempt: number;
    tenantId: string;
    meta: TraceMeta;
    eventCount: number;
    archiveKey?: string;
  }): void;
  /** Ask the hub for a presigned PUT (url absent = skip the upload: dedupe or no storage). */
  requestBlobUrl(req: BlobPutRequestArgs): Promise<{ key: string; url?: string }>;
}

export interface StageRunnerDeps {
  gitService: GitService;
  makeRunner: (runtime: Runner["runtime"]) => Runner;
  /** The node's logger. Absent (tests, embedders) = a silent logger, so the runner stays quiet by
   *  default. Used to surface the best-effort paths below, which used to fail invisibly. */
  logger?: NodeLogger;
  /** Optional self-hosted allowlist of registry repoIds this edge will serve. Empty/absent
   *  = serve any repo (clone on demand). A Job for a repoId outside a non-empty allowlist is
   *  rejected. This is a binding, not a definition: the repo itself comes from the Job's gitUrl. */
  servesRepoIds?: string[];
  /** The tenant this node is bound to. A managed node is configured with its tenant; when set,
   *  a Job for another tenant is refused as defence in depth (the hub's `nodeCanServe` guard should have
   *  prevented the dispatch). Absent = a legacy ambient edge with no tenant binding, so no guard. */
  tenantId?: string;
  /** Composed policy rules (M3: the demo deny rule; M6 adds the builtins). */
  rules: readonly PolicyRule[];
  /** Stream a progress frame to the hub. */
  sendProgress: (progress: JobProgress) => void;
  /** Raise a Linear `select` elicitation for a mid-interactive-stage `AskUserQuestion` (DHK-344): the
   *  edge emits an `elicit` wire frame the hub turns into an elicitation, and the human's pick rides a
   *  `turn` frame back to the blocked tool. Best-effort like `sendProgress`; absent in tests. */
  sendElicit?: (frame: { jobId: string; prompt: string; options: ElicitChoice[]; multiSelect?: boolean }) => void;
  /** Component provisioning: the content-addressed cache the overlay materialises pinned
   *  skills/commands/agents through. Absent = provisioning disabled (no overlay; existing behaviour). */
  packCache?: PackCache;
  /** Ship the normalised trace to the hub for observability (best-effort; omitted = local-only). */
  trace?: TraceSink;
  /** Worktree retention. Safe because finished runs' traces are streamed durably to the
   *  hub, so pruning the local worktree loses nothing observable. Omitted = keep all. */
  retention?: RetentionPolicy;
  /** Base directory for telemetry-only runs: a Job with no `workspaceRef` runs each stage in
   *  a scratch dir under `<scratchRoot>/<runId>` with NO git clone. Git-service still owns the *worktree*
   *  layout; this is only the no-clone scratch base. Defaults to `<tmpdir>/dahrk/scratch`. */
  scratchRoot?: string;
}

/** How many recent runs' worktrees to keep on the edge, and/or how old they may get. */
export interface RetentionPolicy {
  /** Keep at most this many runs' worktrees (the newest by last use). */
  maxRuns?: number;
  /** Tear down a run's worktree once it has been idle this long (ms). */
  maxAgeMs?: number;
}

export interface StageRunner {
  runJob(job: JobRequest): Promise<JobResult>;
  /**
   * Collect worktrees no longer needed by any run: broken ones (their branch ref was deleted under them,
   * so they are unusable AND go on claiming their branch name), idle ones, and anything over the count
   * cap. Restart-safe: reconciles on-disk and git-registered state, not process-local memory. Called at
   * boot (which is what reclaims a leaked disk) and after each stage. Never touches a busy run.
   */
  reapWorktrees(): Promise<ReapReport>;
  /** True while a run is executing a stage on this node. Consulted by the git service before evicting a
   *  stale worktree that still claims a branch, so a live run is never stomped. */
  isBusy(runId: string): boolean;
  /** Commit the run's worktree changes and push its branch (the `open-pr` action's git side). Uses
   *  the run's sticky worktree so the just-run stages' diff is present. No inference. */
  runPush(job: PushJob): Promise<PushResult>;
  /** Cancel an in-flight Job's runner (the Linear `stop` signal, relayed by the hub). */
  cancel(jobId: string): void;
  /** Feed a human turn to an in-flight interactive stage (relayed `prompted` text; M5b). */
  enqueueTurn(jobId: string, turn: HumanTurn): void;
  /** Close an interactive stage's turn stream (the human signed off -> its gate exit; M5b). */
  endTurns(jobId: string): void;
}

const nowIso = (): string => new Date().toISOString();
const PREVIEW = 500;
/** Tool results (`observation` output) get a far larger cap than the noisy PREVIEW kinds: the hub folds
 *  a result into its action's `result` field (DHK-385), so it is user-facing content that must survive
 *  whole in practice, not be clipped mid-content at 500 chars (DHK-384). Bounded to keep pathological
 *  outputs (a whole-repo grep, a large file read) off the control socket; the full-fidelity output is
 *  still preserved in the trace archive via the `outputRef` spill. */
const RESULT = 16_000;

/**
 * Forward-compat shim over `@dahrk/contracts@0.1.0`, which predates DHK-264's backup-push fields. The
 * hub sends `PushJob.mode:"backup"` to preserve a run's committed HEAD on a durable `dahrk/wip/<runId>`
 * ref after a `deliver` push hit a base-advanced conflict; the edge echoes that ref back as
 * `PushResult.wipRef`. `decode` on the wire is a plain `JSON.parse`, so `mode` rides through intact even
 * though the published type omits it (mirrors how this file already forwards the not-yet-published
 * `diverged` integration outcome). Drop these shims and bump the `@dahrk/contracts` dependency once the
 * contract publishing PR (harness #262) has released these fields.
 */
type PushMode = "deliver" | "backup";
type PushJobWithMode = PushJob & { mode?: PushMode };
type PushResultWithWip = PushResult & { wipRef?: string };
type PolicyAwareRunnerContext = RunnerContext & {
  authorizeToolUse?: (toolName: string, input: unknown) => PolicyOutcome;
  /** Surface an interactive-stage `AskUserQuestion` as a Linear `select` elicitation (DHK-344). */
  emitElicit?: (question: ElicitQuestion) => void;
};

/** Upload bytes to a hub-minted presigned URL (heavy trace payloads bypass the control socket). */
const putBytes = async (url: string, body: Buffer, contentType: string): Promise<void> => {
  await fetch(url, { method: "PUT", headers: { "content-type": contentType }, body: new Uint8Array(body) });
};

/** The text an edge sends to the hub for a progress frame, so the hub can post a Linear activity
 *  without reading this edge's trace files. Intermediate steps (thoughts, tool inputs/outputs,
 *  errors) are a bounded PREVIEW: they are noisy and only need to be glanceable. The final
 *  `response` and a gate `elicitation` prompt are the agent's user-facing output that a human reads
 *  in full, so they are sent whole and NOT clipped (matching the engine summary, posted unbounded).
 *
 *  `action` and `observation` also carry their `toolUseId` (DHK-384), so the hub can pair a tool call
 *  with its result by id rather than by adjacency, which breaks when parallel/deferred tools interleave
 *  (e.g. `ToolSearch`). Observation output uses the larger RESULT cap so a folded result is not lost
 *  mid-content. `toolUseId` is additive on the wire: `JobProgress` in the published `@dahrk/contracts`
 *  predates the field, so it rides through the plain-JSON transport untyped until the contract is
 *  republished (same forward-compat pattern as the PushMode shim above). */
function previewOf(event: TraceEvent): { text?: string; tool?: string; toolUseId?: string } {
  const clip = (v: unknown, max = PREVIEW): string =>
    (typeof v === "string" ? v : JSON.stringify(v) ?? "").slice(0, max);
  switch (event.type) {
    case "response":
      return event.text !== undefined ? { text: event.text } : {};
    case "elicitation":
      return { text: event.prompt };
    case "thought":
      return event.text !== undefined ? { text: clip(event.text) } : {};
    case "action":
      return {
        tool: event.tool,
        toolUseId: event.toolUseId,
        ...(event.input !== undefined ? { text: clip(event.input) } : {}),
      };
    case "observation":
      return {
        toolUseId: event.toolUseId,
        ...(event.output !== undefined ? { text: clip(event.output, RESULT) } : {}),
      };
    case "error":
      return { text: clip(event.message) };
    default:
      return {};
  }
}
const attemptOf = (jobId: string): number => {
  const m = /-(\d+)$/.exec(jobId);
  return m ? Number(m[1]) : 1;
};
const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)}`;

/** Merge this stage's progress into the engine-owned scratch state.json. */
function writeScratchState(ref: WorkspaceRef, job: JobRequest, attempt: number, status: string): void {
  const statePath = join(ref.scratchPath, "state.json");
  let state: { runId: string; tenantId: string; stages: Record<string, unknown> };
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    state = { runId: job.runId, tenantId: job.tenantId, stages: {} };
  }
  state.stages[job.stageId] = { currentAttempt: attempt, status };
  mkdirSync(ref.scratchPath, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/** Persist the run's Linear ticket brief into the worktree scratch (idempotent), so a stage can
 *  re-read it as well as receiving it inline. Best-effort; the agent also gets it in its prompt. */
function writeIssueContext(ref: WorkspaceRef, issueContext: string | undefined): void {
  if (issueContext === undefined) return;
  try {
    mkdirSync(ref.scratchPath, { recursive: true });
    writeFileSync(join(ref.scratchPath, "issue.md"), issueContext);
  } catch {
    /* best-effort; the brief still reaches the agent via the stage prompt */
  }
}

/** Persist each attached Linear document's full body into `.dahrk/scratch/docs/<slug>.md`, so the
 *  agent can read the complete text even when the prompt only inlines a capped excerpt. Best-effort;
 *  the slug is sanitised so a malformed value cannot escape the docs directory. */
function writeAttachedDocuments(ref: WorkspaceRef, docs: JobRequest["attachedDocuments"]): void {
  if (!docs || docs.length === 0) return;
  try {
    const dir = join(ref.scratchPath, "docs");
    mkdirSync(dir, { recursive: true });
    for (const doc of docs) {
      writeFileSync(join(dir, `${attachedDocBasename(doc)}.md`), doc.content);
    }
  } catch {
    /* best-effort; a capped excerpt still reaches the agent via the stage prompt */
  }
}

/** Render the run's Linear guidance into a readable markdown block for the scratch file, one
 *  bulleted rule per line annotated with its origin/team. Shared shape with the prompt's `<guidance>`
 *  block (the runner builds the prompt form); this is the on-disk companion. */
function renderGuidanceMarkdown(guidance: NonNullable<JobRequest["guidance"]>): string {
  const lines = guidance.map((rule) => {
    const scope = rule.teamName ? `${rule.origin}: ${rule.teamName}` : rule.origin;
    return `- (${scope}) ${rule.content.trim()}`;
  });
  return `# Workspace guidance\n\n${lines.join("\n")}\n`;
}

/** Persist the run's workspace/team guidance into `.dahrk/scratch/guidance.md`, so a stage
 *  can re-read it as well as receiving it inline in the prompt. Best-effort, mirroring `writeIssueContext`. */
function writeGuidance(ref: WorkspaceRef, guidance: JobRequest["guidance"]): void {
  if (!guidance || guidance.length === 0) return;
  try {
    mkdirSync(ref.scratchPath, { recursive: true });
    writeFileSync(join(ref.scratchPath, "guidance.md"), renderGuidanceMarkdown(guidance));
  } catch {
    /* best-effort; the guidance still reaches the agent via the stage prompt */
  }
}

/** Largest artifact body returned on a JobResult; a feasibility report fits comfortably and this caps
 *  the WebSocket frame. Larger files are truncated (the agent should keep the deliverable concise). */
const ARTIFACT_CAP_BYTES = 64 * 1024;

/** Worktree-relative directory workflows conventionally write deliverables to (mirrors the prompt
 *  guidance in the sample workflows). Scanned as a fallback when the declared path did not resolve. */
const SCRATCH_OUTPUT_DIR = ".dahrk/scratch/output";
/** Transition compat path (2/7 → 5/7): old-path workflow prompts write here; the compat symlink
 *  normally routes these to SCRATCH_OUTPUT_DIR, but we also read this directly as a fallback for
 *  worktrees set up before the symlink was introduced. Removed in 5/7 cleanup. */
const SCRATCH_OUTPUT_DIR_LEGACY = ".skakel/scratch/output";

function capContent(raw: string): string {
  return raw.length > ARTIFACT_CAP_BYTES ? raw.slice(0, ARTIFACT_CAP_BYTES) : raw;
}

function resolveWorktreeRelativePath(ref: WorkspaceRef, relPath: string): string | undefined {
  if (isAbsolute(relPath)) return undefined;
  const root = resolve(ref.worktreePath);
  const target = resolve(root, relPath);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return undefined;
  }
  return target;
}

function isSafeWorktreeRelativePath(ref: WorkspaceRef, relPath: string): boolean {
  return resolveWorktreeRelativePath(ref, relPath) !== undefined;
}

/** Read the file a stage declared via `emitArtifact` (worktree-relative) so a later `attach-document`
 *  action can publish it to Linear. Best-effort: a missing/unreadable file returns undefined and the
 *  action surfaces the absence. Reading is data assembly, not control flow. */
function readEmittedArtifact(ref: WorkspaceRef, relPath: string): { path: string; content: string } | undefined {
  const path = resolveWorktreeRelativePath(ref, relPath);
  if (!path) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    return { path: relPath, content: capContent(raw) };
  } catch {
    return undefined;
  }
}

/** Fallback: a markdown deliverable under the scratch output dir, preferring one whose basename
 *  matches the declared path (the agent may have written a differently-named file to the right dir).
 *  Tries the canonical `.dahrk/scratch/output` first; falls back to the legacy `.skakel/scratch/output`
 *  for worktrees set up before the compat symlink was introduced (removed in 5/7 cleanup). */
function scanScratchOutput(ref: WorkspaceRef, preferRel?: string): { path: string; content: string } | undefined {
  const preferBase = preferRel?.split("/").pop();
  for (const dir of [SCRATCH_OUTPUT_DIR, SCRATCH_OUTPUT_DIR_LEGACY]) {
    try {
      const names = readdirSync(join(ref.worktreePath, dir)).filter((n) =>
        n.toLowerCase().endsWith(".md"),
      );
      if (names.length === 0) continue;
      const pick = (preferBase && names.includes(preferBase) ? preferBase : names[0]) as string;
      const raw = readFileSync(join(ref.worktreePath, dir, pick), "utf8");
      if (raw.trim().length === 0) continue;
      return { path: `${dir}/${pick}`, content: capContent(raw) };
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

/** Last-resort fallback: any new or modified markdown file in the worktree (the agent wrote the
 *  deliverable somewhere entirely different). Best-effort and clearly labelled at the call site, since
 *  it can pick a file that was never intended as the document. */
function scanChangedMarkdown(ref: WorkspaceRef): { path: string; content: string } | undefined {
  const git = (args: string[]): string[] => {
    try {
      return execFileSync("git", ["-C", ref.worktreePath, ...args], { encoding: "utf8" })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const rels = [...git(["ls-files", "--others", "--exclude-standard"]), ...git(["diff", "--name-only"])].filter(
    (p) => p.toLowerCase().endsWith(".md"),
  );
  for (const rel of rels) {
    try {
      const raw = readFileSync(join(ref.worktreePath, rel), "utf8");
      if (raw.trim().length > 0) return { path: rel, content: capContent(raw) };
    } catch {
      /* skip unreadable (e.g. staged-then-deleted) entries */
    }
  }
  return undefined;
}

/** Resolve a stage's deliverable document from the first channel that yields content, so a later
 *  `attach-document` publishes it however the prompt author produced it. Precedence: the declared
 *  `emitArtifact` file, then a document handed back through `dahrk_stage_complete` (the in-band
 *  channel, e.g. when the stage wrote no file), then a scan of the scratch output dir, then any
 *  changed markdown. Only invoked when the stage signalled it intends a document (declared a path, or
 *  handed one back), so ordinary code/build stages are never scanned. Read-only data assembly - never
 *  control flow. */
export function resolveStageArtifact(
  ref: WorkspaceRef,
  emitArtifact: string | undefined,
  handedBack: { path: string; content: string } | undefined,
): { artifact: { path: string; content: string }; source: string } | undefined {
  if (emitArtifact) {
    const declared = readEmittedArtifact(ref, emitArtifact);
    if (declared && declared.content.trim().length > 0) return { artifact: declared, source: "declared-file" };
  }
  if (handedBack && handedBack.content.trim().length > 0 && isSafeWorktreeRelativePath(ref, handedBack.path)) {
    return { artifact: { path: handedBack.path, content: capContent(handedBack.content) }, source: "tool-handoff" };
  }
  const scratch = scanScratchOutput(ref, emitArtifact);
  if (scratch) return { artifact: scratch, source: "scratch-scan" };
  const changed = scanChangedMarkdown(ref);
  if (changed) return { artifact: changed, source: "changed-file" };
  return undefined;
}

/**
 * Whether a runtime consumes brokered MCP servers through the node-local gateway proxy, and so needs
 * the gateway started for a stage that declares them (DHK-507). True for Claude (SDK-native MCP) and
 * Pi (its extension bridge, `createBrokeredMcpExtension`); false for Codex, whose SDK has no MCP - a
 * proxy for it would be dead weight. Pure + exported so the gate is unit-testable without standing up
 * the whole stage runner (`startMcpGateway` binds a real socket).
 */
export function runtimeUsesMcpGateway(runtime: Runner["runtime"]): boolean {
  return runtime === "claude-code" || runtime === "pi";
}

export function createStageRunner(deps: StageRunnerDeps): StageRunner {
  const worktrees = new Map<string, WorkspaceRef>();
  /** Silent by default so an embedder (and every existing test) sees no new output. */
  const log = deps.logger ?? createNodeLogger({ level: "silent" });
  /** In-flight runners by jobId, so a `cancel` frame can abort the right one. */
  const active = new Map<string, Runner>();
  /** Per-job turn mailboxes for in-flight interactive stages (fed by relayed turns; M5b). */
  const turnQueues = new Map<string, ManagedMailbox<HumanTurn>>();
  /** Run-scoped tool-call tallies for max_tool_calls (sticky, like the worktree). */
  const runToolCalls = new Map<string, { count: number }>();
  /** Last-use epoch ms per run, for recency-based retention. */
  const lastUsed = new Map<string, number>();
  /** Count of in-flight jobs per run, so retention never tears down a busy worktree. */
  const inFlight = new Map<string, number>();

  /** True while a run is executing a stage on THIS node. The reaper and the stale-claim eviction in
   *  `createWorktree` both consult it, so a live run is never collected or stomped. */
  const isBusy = (runId: string): boolean => (inFlight.get(runId) ?? 0) > 0;
  const reaperDryRun = process.env.DAHRK_REAPER_DRY_RUN === "1";
  const reaper = createWorktreeReaper({
    worktreesDir: deps.gitService.worktreesDir,
    mirrorsDir: resolveMirrorsDir(),
    isBusy,
    logger: { info: (m) => console.log(`REAPER ${m}`), warn: (m) => console.warn(`REAPER ${m}`) },
  });
  /** Runs whose workspace is a telemetry-only scratch dir, not a git worktree, so teardown
   *  removes the directory directly rather than calling `git worktree remove` (which would fail). */
  const scratchOnly = new Set<string>();

  /** Tear down a finished run's worktree and drop its sticky state. */
  const teardownRun = async (runId: string): Promise<void> => {
    const ref = worktrees.get(runId);
    if (ref) {
      if (scratchOnly.has(runId)) {
        try {
          rmSync(ref.worktreePath, { recursive: true, force: true });
        } catch (e) {
          /* best-effort; a leftover scratch dir loses nothing observable (traces are streamed) - but a
             disk that keeps failing to clear them eventually fills, so say so. */
          log.warn({ err: e, runId, path: ref.worktreePath }, "teardown: could not remove scratch dir");
        }
      } else {
        await deps.gitService.teardownWorktree(ref).catch((e: unknown) => {
          // A worktree that will not tear down holds both disk and its branch name, which then wedges
          // the next run of the same issue. Silent failure here is how a node slowly gums up.
          log.warn({ err: e, runId, path: ref.worktreePath }, "teardown: could not remove worktree");
        });
      }
    }
    worktrees.delete(runId);
    scratchOnly.delete(runId);
    lastUsed.delete(runId);
    runToolCalls.delete(runId);
  };

  /**
   * Collect worktrees that are no longer needed. Two layers, deliberately:
   *
   *  1. The REAPER, which reconciles what is on disk and what git has registered. It is the load-bearing
   *     one, because it is restart-safe: the in-memory maps below are empty after a process restart, so
   *     anything a previous process created was previously orphaned for ever (that is how one node
   *     reached 92 worktrees and 65 GB, DHK-371). It also runs with real DEFAULTS - "no retention policy
   *     configured" used to mean "never collect anything", which is not a safe default for a disk.
   *  2. The original in-memory LRU, kept for the telemetry-only scratch runs the reaper does not own.
   *
   * Never collects the run we just used, nor any run with an in-flight job. Best-effort throughout:
   * a failure to tidy up must never fail a stage.
   */
  const applyRetention = async (keepRunId: string): Promise<void> => {
    const policy = deps.retention;
    await reaper
      .reap({
        ...(policy?.maxRuns !== undefined ? { maxRuns: policy.maxRuns } : {}),
        ...(policy?.maxAgeMs !== undefined ? { maxIdleMs: policy.maxAgeMs } : {}),
        ...(reaperDryRun ? { dryRun: true } : {}),
      })
      .catch(() => undefined);
    if (!policy) return;
    const prunable = (id: string): boolean => id !== keepRunId && (inFlight.get(id) ?? 0) === 0;
    const now = Date.now();
    if (policy.maxAgeMs !== undefined) {
      for (const id of [...worktrees.keys()]) {
        if (prunable(id) && now - (lastUsed.get(id) ?? 0) > policy.maxAgeMs) await teardownRun(id);
      }
    }
    if (policy.maxRuns !== undefined && worktrees.size > policy.maxRuns) {
      const byOldest = [...worktrees.keys()]
        .filter(prunable)
        .sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0));
      let excess = worktrees.size - policy.maxRuns;
      for (const id of byOldest) {
        if (excess <= 0) break;
        await teardownRun(id);
        excess--;
      }
    }
  };

  return {
    isBusy,

    async reapWorktrees() {
      return reaper.reap(reaperDryRun ? { dryRun: true } : {});
    },

    async runJob(job) {
      const { stageId, jobId, runId, agentConfig } = job;
      const attempt = attemptOf(jobId);

      // Defence in depth: a tenant-bound node refuses a Job for another tenant. The hub's
      // `nodeCanServe` tenant guard should have kept this Job off this node, so reaching here is a
      // routing bug; fail closed rather than run a foreign tenant's stage. Absent binding = a legacy
      // ambient edge, which keeps its untenanted behaviour.
      if (deps.tenantId && job.tenantId !== deps.tenantId) {
        return {
          jobId,
          status: "fail",
          summary: `node (tenant "${deps.tenantId}") refuses a job for tenant "${job.tenantId}"`,
        };
      }

      // Honour the optional self-hosted allowlist: refuse a repo this edge did not opt into. A
      // non-empty allowlist that excludes the Job's repoId fails the stage with a clear message
      // (the hub should not have dispatched it; this is the edge-side guard). A telemetry-only run
      // carries no repo, so the allowlist does not apply.
      const allow = deps.servesRepoIds;
      if (job.workspaceRef && allow && allow.length > 0 && !allow.includes(job.workspaceRef.repoId)) {
        return { jobId, status: "fail", summary: `edge does not serve repo "${job.workspaceRef.repoId}"` };
      }

      inFlight.set(runId, (inFlight.get(runId) ?? 0) + 1);
      // Wrapped so EVERY exit path releases the marker. Previously the decrement sat inside `finish`,
      // which a throw before it (e.g. `createWorktree` failing) skipped entirely, leaving the run
      // marked busy for ever and hiding it from every reaper pass keyed on `isBusy` (DHK-371).
      try {
        lastUsed.set(runId, Date.now());

        // Workspace once per run (sticky owner; reused on re-dispatch and across stages).
        // - Customer-repo run: build a git worktree, cloning on demand from the Job's gitUrl - no
        //   pre-cloned local repo needed.
        // - Telemetry-only run: no `workspaceRef`, so synthesise a scratch-only workspace under
        //   `<scratchRoot>/<runId>` with NO git clone. The empty repo fields mark it repo-free; every
        //   downstream reader uses the resolved `ref`, not `job.workspaceRef`.
        let ref = worktrees.get(runId);
        if (!ref) {
          if (job.workspaceRef) {
            ref = await deps.gitService.createWorktree({
              repoId: job.workspaceRef.repoId,
              gitUrl: job.workspaceRef.gitUrl,
              baseBranch: job.workspaceRef.baseBranch,
              runId,
              repo: job.workspaceRef.repo,
              // Stable per-issue branch (continuation); absent = legacy dahrk/<runId>.
              ...(job.workspaceRef.branch ? { branch: job.workspaceRef.branch } : {}),
              // Re-enter from work a prior backup push preserved, rather than starting over from the base
              // (DHK-264). Carried on the contract but never plumbed through to the git service until now.
              ...((job.workspaceRef as { seedRef?: string }).seedRef
                ? { seedRef: (job.workspaceRef as { seedRef?: string }).seedRef }
                : {}),
              // Brokered git credential for this job; absent on ambient nodes (host creds used).
              ...(job.workspaceRef.credentialToken
                ? { credentialToken: job.workspaceRef.credentialToken }
                : {}),
            });
          } else {
            const base = deps.scratchRoot ?? join(tmpdir(), "dahrk", "scratch");
            const worktreePath = join(base, runId);
            const scratchPath = join(worktreePath, ".dahrk", "scratch");
            mkdirSync(scratchPath, { recursive: true });
            ref = { repoId: "", gitUrl: "", repo: "", baseBranch: "", worktreePath, scratchPath };
            scratchOnly.add(runId);
          }
          worktrees.set(runId, ref);
        }
        writeScratchState(ref, job, attempt, "in-flight");
        writeIssueContext(ref, job.issueContext);
        writeGuidance(ref, job.guidance);
        writeAttachedDocuments(ref, job.attachedDocuments);
        // Pre-create the parent of a declared output artifact so the agent's relative write succeeds
        // even if it does not mkdir first.
        if (job.agentConfig.emitArtifact) {
          const artifactDir = resolveWorktreeRelativePath(ref, job.agentConfig.emitArtifact);
          const slash = job.agentConfig.emitArtifact.lastIndexOf("/");
          if (artifactDir && slash > 0) {
            try {
              mkdirSync(join(ref.worktreePath, job.agentConfig.emitArtifact.slice(0, slash)), { recursive: true });
            } catch {
              /* best-effort; the agent can still create the directory itself */
            }
          }
        }

        // Per-stage MCP gateway proxy: holds this job's brokered MCP creds and injects them on
        // outbound calls so the agent never sees them. Started below (Claude only) and stopped in
        // `finish`, so minted tokens are discarded with the stage. Declared here so `finish` closes over it.
        let gateway: McpGateway | undefined;

        const meta: TraceMeta = {
          tenantId: job.tenantId,
          runId,
          stageId,
          jobId,
          attempt,
          runtime: agentConfig.runtime,
          model: agentConfig.model,
          sessionId: job.sessionId,
          configDigest: digest(agentConfig),
          startedAt: nowIso(),
        };
        const writer = createTraceWriter(ref.scratchPath, meta);
        // Stream every written event to the hub as it is appended (the live, full-fidelity
        // corpus). The event carries its writer-assigned seq, so the hub persists the
        // identical record and can detect gaps. Best-effort; a missing sink is local-only.
        const streamEvent = (e: TraceEvent): void =>
          deps.trace?.event({ runId, stageId, attempt, tenantId: job.tenantId, event: e });
        streamEvent(
          writer.append({ seq: 0, ts: nowIso(), type: "state", runtime: agentConfig.runtime, event: "attempt-start" }),
        );

        // At stage exit: upload heavy spilled blobs + the finalised trace.jsonl archive to
        // object storage (via hub-minted presigned URLs), then send the authoritative meta.
        const shipFinalTrace = async (finalMeta: TraceMeta): Promise<void> => {
          const sink = deps.trace;
          if (!sink) return;
          const base = { tenantId: job.tenantId, runId, stageId, attempt };
          try {
            for (const name of readdirSync(join(writer.dir, "blobs"))) {
              const bytes = readFileSync(join(writer.dir, "blobs", name));
              const { url } = await sink.requestBlobUrl({
                ...base, sha256: name, size: bytes.length, contentType: "application/octet-stream", slot: "blob",
              });
              if (url) await putBytes(url, bytes, "application/octet-stream");
            }
          } catch {
            /* best-effort; the streamed events are already persisted */
          }
          let archiveKey: string | undefined;
          try {
            const bytes = readFileSync(join(writer.dir, "trace.jsonl"));
            const sha = createHash("sha256").update(bytes).digest("hex");
            const { key, url } = await sink.requestBlobUrl({
              ...base, sha256: sha, size: bytes.length, contentType: "application/x-ndjson", slot: "archive",
            });
            if (url) await putBytes(url, bytes, "application/x-ndjson");
            archiveKey = key;
          } catch {
            /* best-effort */
          }
          sink.finalised({ ...base, meta: finalMeta, eventCount: writer.count(), ...(archiveKey ? { archiveKey } : {}) });
        };

        const finish = async (
          status: JobStatus,
          summary: string,
          sessionId?: string,
          costUsd?: number,
          handedBackDoc?: { path: string; content: string },
        ): Promise<JobResult> => {
          active.delete(jobId);
          turnQueues.delete(jobId);
          // discard brokered MCP creds with the stage. A gateway that will not stop is holding a port
          // and, worse, live brokered credentials - never let that pass unremarked.
          await gateway?.stop().catch((e: unknown) => log.warn({ err: e, jobId }, "mcp gateway: stop failed"));
          gateway = undefined;
          streamEvent(
            writer.append({ seq: 0, ts: nowIso(), type: "state", runtime: agentConfig.runtime, event: "stage-exit", status }),
          );
          const endedAt = nowIso();
          writer.finalise({ status, endedAt, ...(sessionId ? { sessionId } : {}) });
          writeScratchState(ref!, job, attempt, status);
          const finalMeta: TraceMeta = {
            ...meta, status, endedAt,
            ...(sessionId ? { sessionId } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
          };
          // The single most important best-effort path on the node. If this fails the hub ends up with
          // no finalised trace for the stage - the entire forensic record of what the agent did - and
          // until now nobody found out. It stays non-fatal (the stage result still goes back), but it is
          // logged at error: a run whose trace is missing hub-side has its explanation right here.
          await shipFinalTrace(finalMeta).catch((e: unknown) =>
            log.error({ err: e, runId, stageId: job.stageId, jobId, attempt }, "trace: failed to ship the final trace to the hub"),
          );
          lastUsed.set(runId, Date.now());
          // NB the `inFlight` decrement is NOT here: `finish` is not reached when the job throws before it
          // (e.g. `createWorktree` failing on a stale branch claim), which left the run marked busy for ever
          // and made it invisible to every reaper pass keyed on `isBusy` - exactly the runs that most needed
          // collecting. It now lives in the `finally` of `runJob`, which every exit path goes through.
          await applyRetention(runId).catch((e: unknown) => log.warn({ err: e, runId }, "retention: pass failed"));
          // When the stage intends a document (declared an `emitArtifact` path, or handed one back via
          // `dahrk_stage_complete`) and succeeded, resolve it from whichever channel produced content
          // so the engine can publish it (e.g. the `attach-document` action). Read-only; a miss returns
          // undefined and the action surfaces the absence. Ordinary code/build stages are not scanned.
          const wantsArtifact = agentConfig.emitArtifact !== undefined || handedBackDoc !== undefined;
          const resolved =
            status === "ok" && wantsArtifact
              ? resolveStageArtifact(ref!, agentConfig.emitArtifact, handedBackDoc)
              : undefined;
          if (status === "ok" && wantsArtifact) {
            const detail = resolved
              ? `source=${resolved.source} path=${resolved.artifact.path} bytes=${resolved.artifact.content.length}`
              : "no document resolved (declared path, tool handoff, and scratch/changed-file scans all empty)";
            streamEvent(
              writer.append({ seq: 0, ts: nowIso(), type: "state", runtime: agentConfig.runtime, event: "artifact", detail }),
            );
          }
          return {
            jobId,
            status,
            summary,
            ...(sessionId ? { sessionId } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
            ...(resolved ? { artifact: resolved.artifact } : {}),
          };
        };

        // Component provisioning: overlay the run's pinned skills/commands/agents into the
        // worktree `.claude/` before the runner starts, normalised per runtime (Claude writes files
        // with repo-local precedence; Codex warns and skips). Idempotent, so re-dispatch on the sticky
        // worktree is safe. Fail closed: a missing pinned component is a correctness problem, not
        // cosmetic, so a materialise/overlay error fails the stage rather than running without it.
        if (deps.packCache && job.provision && job.provision.length > 0) {
          try {
            const overlay = await overlayComponents({
              worktreePath: ref.worktreePath,
              runtime: agentConfig.runtime,
              components: job.provision,
              cache: deps.packCache,
            });
            const detail = `provision: ${overlay.written.length} written, ${overlay.skippedRepoLocal.length} repo-local, ${overlay.warnings.length} warning(s)`;
            streamEvent(
              writer.append({ seq: 0, ts: nowIso(), type: "state", runtime: agentConfig.runtime, event: "provision", detail }),
            );
            // Surface the summary (and any Codex warnings) to the hub so the overlay is observable.
            const noteText = overlay.warnings.length > 0 ? `${detail}; ${overlay.warnings.join("; ")}` : detail;
            deps.sendProgress({ jobId, kind: "observation", ts: nowIso(), text: noteText });
          } catch (e) {
            const msg = `component provisioning failed: ${(e as Error).message}`;
            writer.append({ seq: 0, ts: nowIso(), type: "error", runtime: agentConfig.runtime, kind: "provision-failed", message: msg });
            deps.sendProgress({ jobId, kind: "error", ts: nowIso(), text: msg });
            return finish("fail", `${stageId}: ${msg}`, job.sessionId);
          }
        }

        // Compose this Job's policies (workflow+stage builtins the engine threaded) with the
        // edge's demo rules. The run-scoped counter is shared across the run's stages.
        let counter = runToolCalls.get(runId);
        if (!counter) {
          counter = { count: 0 };
          runToolCalls.set(runId, counter);
        }
        const jobRules = buildRules(job.policies ?? [], {
          worktreePath: ref.worktreePath,
          repoName: job.workspaceRef?.repo ?? "",
          runToolCalls: counter,
          // DHK-392: the stage is confined to the run's worktree (plus its scratch dir, the git object
          // store it depends on, and the toolchain). A node default, not a workflow policy. A run with
          // no repo still gets a box - just a smaller one, around its scratch dir.
          fsRoots: computeFsRoots({ worktreePath: ref.worktreePath, scratchPath: ref.scratchPath }),
        });
        const rules = [...jobRules, ...deps.rules];

        // Policy at stage entry.
        const entry = evaluatePolicies({ kind: "stage-entry", stageId }, rules);
        if (entry.verdict === "deny") {
          writer.append({ seq: 0, ts: nowIso(), type: "state", runtime: agentConfig.runtime, event: "policy-deny", detail: entry.reason });
          return finish("fail", `${stageId}: denied at stage entry (${entry.policy})`, job.sessionId);
        }

        // Run the stage, intercepting tool actions for policy and streaming progress.
        let denied = false;
        // Deny reasons already surfaced to the human this stage. A cap or a retried blocked command
        // denies every subsequent action with the SAME reason, and each `kind:"error"` progress frame
        // becomes a Linear comment - so an uncapped storm posted a wall of identical comments (DHK-493).
        // Reset per stage (this closure is per job); the trace + agent-facing observation still record
        // every deny, we only collapse the human-visible comment to one per distinct reason.
        const surfacedDenyReasons = new Set<string>();
        // DHK-392: a confinement breach caught only AFTER the tool ran. Claude blocks pre-execution
        // (`canUseTool`), so this can only happen on Codex/Pi, which expose no such hook - there the
        // command has already scanned whatever it scanned, and a quiet note on the summary would be a
        // lie. Escalated to a stage failure below. Gated on runtime, not inferred: on Claude a
        // pre-denied tool can still surface an action event here, and that must NOT fail the stage.
        let escapedUnblocked = false;
        const authorisedActions: string[] = [];
        const runtime = agentConfig.runtime;
        const actionKey = (tool: string, input: unknown): string => {
          try {
            return `${tool}\0${JSON.stringify(input)}`;
          } catch {
            return `${tool}\0`;
          }
        };
        const policyReason = (verdict: PolicyOutcome): string => verdict.reason ?? `tool action denied by ${verdict.policy}`;
        const recordDeny = (verdict: PolicyOutcome, toolUseId?: string): void => {
          denied = true;
          const reason = policyReason(verdict);
          if (toolUseId) {
            streamEvent(writer.append({ seq: 0, ts: nowIso(), type: "observation", runtime, toolUseId, isError: true, output: { error: reason } }));
          }
          streamEvent(writer.append({ seq: 0, ts: nowIso(), type: "state", runtime, event: "policy-deny", detail: reason }));
          const surfaceKey = `${verdict.policy}\0${reason}`;
          if (!surfacedDenyReasons.has(surfaceKey)) {
            surfacedDenyReasons.add(surfaceKey);
            deps.sendProgress({ jobId, kind: "error", ts: nowIso(), text: reason });
          }
        };
        const authorizeToolUse = (tool: string, input: unknown): PolicyOutcome => {
          const verdict = evaluatePolicies({ kind: "action", stageId, tool, input }, rules);
          if (verdict.verdict === "deny") {
            recordDeny(verdict);
          } else {
            authorisedActions.push(actionKey(tool, input));
          }
          return verdict;
        };
        // Reset hook for the batch output-idle watchdog (armed below, batch stages only). Every
        // streamed trace event is a sign of life, so bumping it here keeps an actively-working stage
        // alive; a no-op until the watchdog is armed.
        let bumpStall: () => void = () => {};
        const onTrace = (event: TraceEvent): void => {
          bumpStall();
          if (event.type === "action") {
            const key = actionKey(event.tool, event.input);
            const authorised = authorisedActions.indexOf(key);
            if (authorised >= 0) {
              authorisedActions.splice(authorised, 1);
            } else {
              const verdict = evaluatePolicies(
                { kind: "action", stageId, tool: event.tool, input: event.input },
                rules,
              );
              if (verdict.verdict === "deny") {
                streamEvent(writer.append(event));
                recordDeny(verdict, event.toolUseId);
                if (verdict.policy === "fs_confine" && runtime !== "claude-code") escapedUnblocked = true;
                return;
              }
            }
          }
          streamEvent(writer.append(event));
          if (event.type !== "state") deps.sendProgress({ jobId, kind: event.type, ts: event.ts, ...previewOf(event) });
        };

        // Start the per-stage MCP gateway when the stage declares brokered MCP servers, for every
        // runtime that can route MCP through it: Claude (SDK-native) and Pi (its extension bridge,
        // DHK-507). Codex is excluded - its SDK has no MCP, so a proxy would be dead weight (the codex
        // adapter logs and ignores declared servers). The gateway holds the token and injects it
        // upstream, so the agent never sees the raw secret (`mcpProxyBaseUrl` seam) regardless of runtime.
        const mcpServers = agentConfig.mcpServers;
        if (mcpServers && mcpServers.length > 0 && runtimeUsesMcpGateway(runtime)) {
          gateway = await startMcpGateway({ servers: mcpServers, creds: job.brokeredCreds ?? {} });
        }

        const runner = deps.makeRunner(runtime);
        active.set(jobId, runner);
        const ctx: PolicyAwareRunnerContext = {
          config: agentConfig,
          workspace: ref,
          sessionId: job.sessionId,
          ...(job.issueContext !== undefined ? { issueContext: job.issueContext } : {}),
          ...(job.guidance !== undefined ? { guidance: job.guidance } : {}),
          ...(job.gateFeedback !== undefined ? { gateFeedback: job.gateFeedback } : {}),
          ...(job.attachedDocuments !== undefined ? { attachedDocuments: job.attachedDocuments } : {}),
          ...(gateway ? { mcpProxyBaseUrl: gateway.baseUrl } : {}),
          // brokered inference env for a managed node (no operator login). The runtime adapter
          // (Pi) / container executor apply it as the inference process env, so the raw key is
          // never surfaced to the agent's own tool calls. Absent on ambient nodes; inert for the Claude/
          // Codex adapters, which use ambient inference.
          ...(job.runtimeEnv ? { runtimeEnv: job.runtimeEnv } : {}),
          // The adapter persists each runtime-native record under the attempt's raw/ sidecar
          // and stamps the rawRef onto the emitted event.
          writeRaw: writer.writeRaw,
          authorizeToolUse,
          // Wire the interactive AskUserQuestion elicitation seam (DHK-344): the adapter calls this when
          // the agent asks a structured question, and the edge relays it to the hub as an `elicit` frame.
          ...(deps.sendElicit
            ? {
                emitElicit: (question: ElicitQuestion) =>
                  deps.sendElicit!({
                    jobId,
                    prompt: question.prompt,
                    options: question.options,
                    ...(question.multiSelect ? { multiSelect: true } : {}),
                  }),
              }
            : {}),
        };
        // Interactive stages run a multi-turn conversation fed by relayed human turns (M5b);
        // batch stages run to a terminal result. Both emit through the same onTrace.
        const interactive = agentConfig.interaction === "interactive";
        let result: Omit<JobResult, "jobId" | "summary"> & { summary?: string };
        // Wall-clock kill (the contract `JobRequest.timeout` promises "on expiry the executor kills the
        // runner; the engine marks the stage timeout"). Enforce it here so it covers batch AND interactive
        // for both adapters: at the deadline we abort the runner via cancel() and force status `timeout`.
        // This bounds real stage runtime below the hub's dispatch deadline (stage timeout + relay margin),
        // so a stage is never re-dispatched while still legitimately executing - the safety prerequisite
        // the re-dispatch leans on. (The edge de-dup in ws-client is the second guard.)
        let timedOut = false;
        const killMs = Math.max(0, Math.floor((job.timeout ?? 0) * 1000));
        const killTimer =
          killMs > 0
            ? setTimeout(() => {
                timedOut = true;
                void runner.cancel();
              }, killMs)
            : undefined;
        // NB: do NOT unref() this timer. It is the active mechanism of the timeout kill; an unref'd
        // timer does not keep the event loop alive, so an otherwise-idle loop could drain before it
        // fires and the kill would never happen. It is always cleared in the `finally` below, so it
        // can never outlive the job.
        //
        // Batch output-idle watchdog. A batch stage has no idle timer of its own, and the wall clock is
        // opt-in (usually absent), so a genuinely hung stage - an orphaned subprocess, a runtime that
        // stops streaming - would otherwise run forever. Cancel the runner if it emits NO trace event
        // (assistant text, tool call, tool result) for `stallMs`; `bumpStall` above resets it on every
        // event, so an actively-working stage is never touched. Batch-only: interactive stages keep
        // their own per-turn idle timer. Override via the stage's `stall_seconds` (-> agentConfig.stallMs,
        // read defensively until the contract republishes) or env `DAHRK_BATCH_STALL_MS`; default 300s.
        let stalled = false;
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        // Stall window source: the stage's `stall_seconds` (surfaced as agentConfig.stallMs), else the
        // env override, else 300s. Sanitised (clamp to a non-negative integer) exactly as killMs above;
        // interactive stages opt out with 0. Reading env has no side effects, so computing the source
        // unconditionally is equivalent to the old interactive-short-circuit.
        const stallSource =
          (agentConfig as { stallMs?: number }).stallMs ??
          Number(process.env.DAHRK_BATCH_STALL_MS ?? process.env.SKAKEL_BATCH_STALL_MS ?? 300_000);
        const stallMs = interactive ? 0 : Math.max(0, Math.floor(stallSource));
        if (stallMs > 0) {
          bumpStall = (): void => {
            if (stallTimer) clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
              stalled = true;
              void runner.cancel();
            }, stallMs);
          };
          bumpStall(); // arm before the first event, so a stage that never streams still trips
        }
        try {
          if (interactive) {
            const mailbox = new ManagedMailbox<HumanTurn>();
            turnQueues.set(jobId, mailbox);
            result = await runner.runInteractive(ctx, mailbox, onTrace);
          } else {
            result = await runner.runBatch(ctx, onTrace);
          }
        } finally {
          if (killTimer) clearTimeout(killTimer);
          if (stallTimer) clearTimeout(stallTimer);
        }
        // A policy deny blocks the individual *action* (already recorded as a policy-deny trace
        // event and streamed as a progress error); the deny-only guards are guardrails the agent
        // is expected to route around, not stage killers. A single guard-blocked action must NOT
        // poison the *stage* verdict: a stage the runner finished cleanly stays `ok` even if one of
        // its tool actions was denied. (Previously any deny forced the whole stage to `fail`, so a
        // recovered-from `rm -rf` on a throwaway scratch dir turned a correctly-completed build into
        // a false-negative.) The deny still surfaces in the trace and in the summary note below.
        // A wall-clock kill and a batch stall both cancel the runner and surface as `timeout` (the same
        // status the old default wall clock produced, so the hub folds them identically). They differ
        // only in the summary below, so a stall is legible in the trace without a new JobStatus variant.
        let status: JobStatus = timedOut || stalled ? "timeout" : result.status;

        // The one deny that DOES kill the stage (DHK-392). On a runtime with no pre-execution hook the
        // confinement breach was detected after the fact: the command already read what it read. That
        // is not a guardrail the agent routed around, it is a guardrail that arrived late, and the
        // honest signal is a loud failure rather than a note at the end of a green stage.
        if (status === "ok" && escapedUnblocked) {
          status = "fail";
          const msg = `stage reached outside the run's worktree and the ${runtime} runtime could not block it before it ran`;
          writer.append({ seq: 0, ts: nowIso(), type: "error", runtime, kind: "fs-confine-escape", message: msg });
          deps.sendProgress({ jobId, kind: "error", ts: nowIso(), text: msg });
        }

        // R4 stage-exit hooks run in the worktree only if the stage otherwise succeeded.
        if (status === "ok" && job.hooks && job.hooks.length > 0) {
          for (const cmd of job.hooks) {
            try {
              execFileSync("sh", ["-c", cmd], { cwd: ref.worktreePath, stdio: ["pipe", "pipe", "pipe"] });
            } catch (e) {
              status = "fail";
              writer.append({ seq: 0, ts: nowIso(), type: "error", runtime, kind: "hook-failed", message: `hook "${cmd}" failed: ${(e as Error).message}` });
              break;
            }
          }
        }

        // Interactive stages return their own handoff summary; a batch stage gets the
        // engine-owned summarisation turn (only after success, never failing the stage).
        let summary = result.summary ?? `${stageId}: ${status}`;
        // A stalled batch stage reports a distinct, legible summary (the runner's own summary is
        // unreliable after a mid-stream cancel). Prefer it over the generic `<stage>: timeout`.
        if (stalled && !timedOut) {
          summary = `${stageId}: stalled (no output for ${Math.round(stallMs / 1000)}s)`;
        }
        if (!interactive && status === "ok") {
          try {
            summary = await runner.summarise(ctx);
          } catch {
            /* keep the fallback summary; a summarise failure must not fail an ok stage */
          }
        }
        // Keep the guardrail hit visible even when the stage still succeeded, so a reviewer can
        // see that an action was blocked without the deny silently flipping the verdict to fail.
        if (denied) summary += "\n\n(note: one or more tool actions were blocked by a deny-only policy guard.)";

        return finish(status, summary, result.sessionId ?? job.sessionId, result.costUsd, result.artifact);
      } finally {
        inFlight.set(runId, Math.max(0, (inFlight.get(runId) ?? 1) - 1));
      }
    },

    async runPush(job) {
      const { runId, jobId } = job;
      const allow = deps.servesRepoIds;
      if (allow && allow.length > 0 && !allow.includes(job.workspaceRef.repoId)) {
        return { jobId, status: "fail", summary: `edge does not serve repo "${job.workspaceRef.repoId}"` };
      }
      lastUsed.set(runId, Date.now());
      // Worktree-survival invariant (DHK-264 follow-up #2): count the push as in-flight for its whole
      // duration so `applyRetention`'s `prunable` guard (`inFlight === 0`) cannot reap this run's
      // worktree mid-push. Together with the `lastUsed` bump above (which makes this the most-recently-
      // used run, so LRU/age pruning evicts others first), it keeps the worktree alive for a follow-up
      // backup push - which depends on the committed HEAD still being present in that worktree.
      inFlight.set(runId, (inFlight.get(runId) ?? 0) + 1);
      try {
        const mode: PushMode = (job as PushJobWithMode).mode ?? "deliver";

        // Work-preservation push (DHK-264): the hub dispatches `mode:"backup"` after a `deliver` push
        // hit a base-advanced conflict, to save the run's committed HEAD on a durable `dahrk/wip/<runId>`
        // ref before the worktree is reaped. It MUST use the run's sticky worktree (which still holds the
        // HEAD) and take the merge-free path - no base integration, no conflict/diverged branch, no PR. If
        // the worktree is already gone the work cannot be preserved, so fail truthfully rather than
        // re-cloning the branch (which would push the base tip and silently lose the run's work).
        if (mode === "backup") {
          const ref = worktrees.get(runId);
          if (!ref) {
            return {
              jobId,
              status: "fail",
              branch: job.branch,
              summary: `backup push: run ${runId} has no live worktree; committed HEAD cannot be preserved`,
            };
          }
          try {
            const r = await deps.gitService.backupPush(ref, {
              message: job.message,
              branch: job.branch,
              ...(job.workspaceRef.credentialToken ? { credentialToken: job.workspaceRef.credentialToken } : {}),
            });
            const result: PushResultWithWip = {
              jobId,
              status: "ok",
              branch: job.branch,
              headSha: r.headSha,
              pushed: r.pushed,
              nothingToCommit: r.nothingToCommit,
              wipRef: r.wipRef,
              summary: `backup: preserved ${r.headSha.slice(0, 7)} on ${r.wipRef} (no base merge, no PR)`,
            };
            return result;
          } catch (e) {
            return { jobId, status: "fail", branch: job.branch, summary: `backup push failed: ${(e as Error).message}` };
          }
        }

        // Resolve the run's sticky worktree so the just-run stages' uncommitted diff is present. The
        // pipeline pushes immediately after the last stage, so retention has not pruned it. Re-create
        // off the stable branch only as a defensive fallback (the branch's prior commits are on the
        // remote; any lost-but-uncommitted stage edits cannot be recovered here - they are gone).
        let ref = worktrees.get(runId);
        if (!ref) {
          ref = await deps.gitService.createWorktree({
            repoId: job.workspaceRef.repoId,
            gitUrl: job.workspaceRef.gitUrl,
            baseBranch: job.workspaceRef.baseBranch,
            runId,
            repo: job.workspaceRef.repo,
            branch: job.branch,
            ...(job.workspaceRef.credentialToken ? { credentialToken: job.workspaceRef.credentialToken } : {}),
          });
          worktrees.set(runId, ref);
        }

        try {
          const r = await deps.gitService.commitAndPush(ref, {
            message: job.message,
            branch: job.branch,
            base: job.base,
            ...(job.workspaceRef.credentialToken ? { credentialToken: job.workspaceRef.credentialToken } : {}),
          });
          // Nothing to deliver (DHK-318): the branch's delta over the (possibly advanced) base is empty
          // or only engine scratch, so the work is already present on the base. Close as a successful
          // no-op - nothing pushed, no PR, no conflictFiles - rather than attempting an integration that
          // could error on a stray scratch path. `status: "ok"` with `nothingToCommit`, so the run reaches
          // a non-error terminal state. (`noop` is not yet in `@dahrk/contracts`'s IntegrationOutcome, so
          // it is conveyed as an absent integration - "treated as clean" no-op - like `diverged` above.)
          if (r.integration === "noop") {
            return {
              jobId,
              status: "ok",
              branch: job.branch,
              headSha: r.headSha,
              pushed: false,
              nothingToCommit: true,
              commitsAhead: r.commitsAhead,
              summary: `no changes to deliver on ${job.branch} - work already present on ${job.base}`,
            };
          }
          // the base advanced and merging it into the branch conflicted, so nothing was pushed.
          // There is nothing to open a PR for; forward the conflict outcome and let the hub raise a
          // manual-merge elicitation. `status: "ok"` (the executor did its job deterministically; a
          // conflict is a real, non-error outcome, not a push failure that should trigger retries).
          if (r.integration === "conflict") {
            return {
              jobId,
              status: "ok",
              branch: job.branch,
              headSha: r.headSha,
              pushed: false,
              nothingToCommit: r.nothingToCommit,
              commitsAhead: r.commitsAhead,
              integration: "conflict",
              ...(r.conflictFiles ? { conflictFiles: r.conflictFiles } : {}),
              summary: `base advanced; merge conflict on ${job.branch} (manual merge needed)`,
            };
          }
          // The branch and base share no common history (unrelated/diverged), so the base can never
          // auto-integrate and nothing was pushed. Unlike a content conflict, an agent cannot resolve
          // this - the branch needs rebuilding from base - so it is a real failure, not an `ok` conflict
          // outcome. Surface it truthfully. (Forward-compat: once `@dahrk/contracts` ships a `diverged`
          // IntegrationOutcome, forward `status: "ok", integration: "diverged"` for a native hub elicitation.)
          if (r.integration === "diverged") {
            return {
              jobId,
              status: "fail",
              branch: job.branch,
              headSha: r.headSha,
              pushed: false,
              nothingToCommit: r.nothingToCommit,
              commitsAhead: r.commitsAhead,
              summary: `branch history diverged from ${job.base}; cannot auto-integrate on ${job.branch} (the branch likely needs rebuilding from ${job.base})`,
            };
          }
          // Ambient nodes only: the hub set `openPr` so the edge best-effort opens the PR here (it holds
          // the host's `gh` auth), symmetric with the ambient push. Skip if the push landed nothing.
          // Failure is non-fatal - carried back as prError so the run stays green on the pushed branch.
          const pr =
            job.openPr && r.pushed
              ? await deps.gitService.openPrAmbient(ref, {
                  branch: job.branch,
                  base: job.base,
                  title: job.openPr.title,
                  body: job.openPr.body,
                })
              : undefined;
          return {
            jobId,
            status: "ok",
            branch: job.branch,
            headSha: r.headSha,
            pushed: r.pushed,
            nothingToCommit: r.nothingToCommit,
            commitsAhead: r.commitsAhead,
            ...(r.integration ? { integration: r.integration } : {}),
            ...(pr?.prUrl ? { prUrl: pr.prUrl } : {}),
            ...(pr?.prNumber !== undefined ? { prNumber: pr.prNumber } : {}),
            ...(pr?.prError ? { prError: pr.prError } : {}),
            summary: r.nothingToCommit
              ? `no changes to commit; ${r.pushed ? "branch pushed" : "nothing pushed"}`
              : `committed ${r.headSha.slice(0, 7)} and pushed ${job.branch}`,
          };
        } catch (e) {
          return { jobId, status: "fail", summary: `push failed: ${(e as Error).message}` };
        }
      } finally {
        inFlight.set(runId, Math.max(0, (inFlight.get(runId) ?? 1) - 1));
      }
    },

    cancel(jobId) {
      // The runner's cancel() aborts the in-flight SDK query (M4). Also close the turn mailbox
      // so an interactive runner blocked awaiting the next turn unwinds. The stage finishes
      // "fail" and the loop unwinds normally.
      void active.get(jobId)?.cancel();
      turnQueues.get(jobId)?.end();
    },

    enqueueTurn(jobId, turn) {
      turnQueues.get(jobId)?.push(turn);
    },

    endTurns(jobId) {
      turnQueues.get(jobId)?.end();
    },
  };
}
