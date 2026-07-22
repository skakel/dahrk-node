/**
 * @dahrk/executor-worktree - the Phase 1 executor (build spec sections 9-10).
 *
 * Three things:
 *  1. Runner adapters: thin wrappers over @anthropic-ai/claude-agent-sdk and
 *     @earendil-works/pi-coding-agent implementing the Runner interface from contracts. Added M4.
 *  2. GitService: VENDORED (copied) from cyrus - worktree create/teardown and
 *     base-branch resolution. Pure git/node logic. Added M3. cyrus-core helpers
 *     are replaced with our own.
 *  3. Trace producer: maps a runtime's native stream to the normalised TraceEvent
 *     envelope (the Claude adapter reuses cyrus's AgentSessionManager mapping), writes
 *     trace.jsonl + meta.json, spills large payloads to blobs/, optionally writes the
 *     raw/ sidecar, and maintains the latest pointer. Added M3 (S3 confirms).
 *
 * Net cyrus runtime dependency: zero npm packages. Only the vendored GitService.
 */
import type { Runner } from "@dahrk/contracts";
import { createMockRunner } from "./mock-runner.js";
import { createClaudeRunner } from "./claude-adapter.js";
import { createPiRunner } from "./pi-adapter.js";
import { createIsolatedPiRunner } from "./pi-container.js";

/** GitService - worktree lifecycle and base-branch resolution (M3). */
export {
  createGitService,
  sanitizeBranchName,
  parseOwnerRepo,
  resolveWorktreesDir,
  resolveMirrorsDir,
} from "./git-service.js";
/** Restart-safe collection of run worktrees (DHK-371). See `worktree-reaper.ts`. */
export { createWorktreeReaper } from "./worktree-reaper.js";
export type { ReapPolicy, ReapReport, ReapedWorktree, ReapReason } from "./worktree-reaper.js";
export type {
  GitService,
  GitServiceOptions,
  GitLogger,
  WorktreeSpec,
  CommitPushOpts,
  CommitPushResult,
  BackupPushOpts,
  BackupPushResult,
  OpenPrOpts,
  OpenPrResult,
} from "./git-service.js";

/** The pure footprint core: parse `git diff --numstat` and derive the blast-radius numbers (DHK-615). */
export { parseNumstat, deriveFootprint } from "./footprint.js";
export type { NumstatEntry, Numstat, DiffFootprint } from "./footprint.js";

/** The trace producer (M3). */
export { createTraceWriter } from "./trace-writer.js";
export type { TraceWriter } from "./trace-writer.js";

/** A push/close async queue, reused by the edge as the per-job turn mailbox (M5b). */
export { ManagedMailbox } from "./mailbox.js";

/** Component provisioning: the content-addressed cache and the overlay-into-worktree step. */
export { createPackCache, readManifestFiles } from "./pack-cache.js";
export type {
  PackCache,
  PackCacheOptions,
  PackSource,
  ComponentBytes,
  ComponentFile,
  MaterialiseResult,
} from "./pack-cache.js";
export { overlayComponents } from "./overlay.js";
export type { OverlayResult, OverlayOptions } from "./overlay.js";

export { createMockRunner } from "./mock-runner.js";

/** The real runner adapters (M4): thin wrappers over the Claude Agent SDK and Pi. */
export { createClaudeRunner } from "./claude-adapter.js";
/** The Pi runtime adapter: the model-agnostic runtime for the managed node. */
export { createPiRunner, PI_STAGE_COMPLETE_TOOL, buildBrokeredPiMcpServers, createBrokeredMcpExtension } from "./pi-adapter.js";
export type { PiSessionLike, PiSessionFactory, PiRunnerDeps, BrokeredPiMcpServer } from "./pi-adapter.js";
/** Container Pi session factory + isolated runner: Docker isolation seam. */
export { createContainerPiSession, createIsolatedPiRunner } from "./pi-container.js";
export type { ContainerPiSessionOpts } from "./pi-container.js";

// The brokered auth-profile hint (DHK-509/511). Exported because the edge's stage runner threads it
// from the Job onto the RunnerContext, so both ends of that seam name the same type.
export type { PiAuthHint, ProviderHint, ApiKeyProviderHint, OAuthProviderHint } from "./pi-auth.js";

/**
 * Construct the runner for a runtime. Defaults to the real adapters; `DAHRK_RUNNER=mock`
 * selects the deterministic, credential-free mock (set by the offline hub harness so its
 * scenarios stay green without Claude/Pi auth).
 *
 * A managed node that requires container isolation sets `DAHRK_PI_ISOLATION=container` to run
 * each Pi stage in a fresh per-job Docker container (`pi --mode rpc`) instead of the embedded
 * in-process session. Known degradation on that path: `PiRpcSession` has no `agent` handle, so
 * `summarise`'s tool-denial is a no-op there (see `pi-rpc-client.ts`); meta-loop stages are
 * telemetry-only, so this is accepted.
 */
export function makeRunner(runtime: Runner["runtime"]): Runner {
  if ((process.env.DAHRK_RUNNER ?? process.env.SKAKEL_RUNNER ?? "real") === "mock") return createMockRunner(runtime);
  if (runtime === "pi") return piContainerIsolationRequired() ? createIsolatedPiRunner() : createPiRunner();
  return createClaudeRunner();
}

/** Whether Pi stages must run container-isolated; a managed node sets `DAHRK_PI_ISOLATION=container`. */
function piContainerIsolationRequired(): boolean {
  return (process.env.DAHRK_PI_ISOLATION ?? process.env.SKAKEL_PI_ISOLATION) === "container";
}
