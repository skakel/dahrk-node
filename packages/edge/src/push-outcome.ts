/**
 * The pure push-outcome ladder: given the result of a git push primitive plus the job's branch/base,
 * build the `PushResult` the edge returns to the hub. Extracted from `stage-runner.runPush` (which owns
 * the I/O - worktree resolution, the `gitService` calls, the PR open) so the deliver/backup/conflict/
 * diverged/noop decision is a plain function with no filesystem, git, or network reach, and can be
 * unit-tested exhaustively rather than only through a full push run.
 *
 * Behaviour is a verbatim move of the former inline ladder; the summaries and field shapes match the
 * hub's expectations exactly.
 */
import type { PushJob, PushResult } from "@dahrk/contracts";
import type { BackupPushResult, CommitPushResult, OpenPrResult } from "@dahrk/executor-worktree";

/**
 * Forward-compat shims over `@dahrk/contracts@0.1.0`, which predates DHK-264's backup-push fields. The
 * hub sends `PushJob.mode:"backup"` to preserve a run's committed HEAD on a durable `dahrk/wip/<runId>`
 * ref after a `deliver` push hit a base-advanced conflict; the edge echoes that ref back as
 * `PushResult.wipRef`. `decode` on the wire is a plain `JSON.parse`, so `mode` rides through intact even
 * though the published type omits it. Drop these shims and bump the `@dahrk/contracts` dependency once
 * the contract publishing PR (harness #262) has released these fields.
 */
export type PushMode = "deliver" | "backup";
export type PushJobWithMode = PushJob & { mode?: PushMode };
export type PushResultWithWip = PushResult & { wipRef?: string };

/** The job facts the deliver ladder needs to phrase its result. */
export interface DeliverOutcomeContext {
  jobId: string;
  branch: string;
  base: string;
}

/** The job facts the backup ladder needs to phrase its result. */
export interface BackupOutcomeContext {
  jobId: string;
  branch: string;
}

/**
 * Map a `commitAndPush` result (plus any already-opened ambient PR) onto the `PushResult`. The four
 * integration outcomes are distinct terminal states:
 *  - `noop`: the branch's delta over the base is empty or scratch-only, so the work is already present.
 *    A successful no-op (`ok`, nothing pushed, no PR).
 *  - `conflict`: the base advanced and merging it into the branch conflicted; nothing pushed. Still
 *    `ok` - the executor did its job deterministically and a conflict is a real, non-error outcome the
 *    hub raises a manual-merge elicitation for.
 *  - `diverged`: the branch and base share no history, so the base can never auto-integrate. Unlike a
 *    content conflict an agent cannot resolve this (the branch needs rebuilding), so it is a real
 *    `fail`.
 *  - clean / absent: the push landed (or found nothing to commit); forward the PR fields if one opened.
 *
 * The PR is opened by the caller (it holds the host `gh` auth) only on the clean path (`r.pushed`), so
 * `pr` is `undefined` for every non-clean outcome and this function never needs to gate on it.
 */
export function resolveDeliverOutcome(
  r: CommitPushResult,
  job: DeliverOutcomeContext,
  pr: OpenPrResult | undefined,
): PushResult {
  const { jobId, branch, base } = job;

  if (r.integration === "noop") {
    return {
      jobId,
      status: "ok",
      branch,
      headSha: r.headSha,
      pushed: false,
      nothingToCommit: true,
      commitsAhead: r.commitsAhead,
      summary: `no changes to deliver on ${branch} - work already present on ${base}`,
    };
  }
  if (r.integration === "conflict") {
    return {
      jobId,
      status: "ok",
      branch,
      headSha: r.headSha,
      pushed: false,
      nothingToCommit: r.nothingToCommit,
      commitsAhead: r.commitsAhead,
      integration: "conflict",
      ...(r.conflictFiles ? { conflictFiles: r.conflictFiles } : {}),
      summary: `base advanced; merge conflict on ${branch} (manual merge needed)`,
    };
  }
  if (r.integration === "diverged") {
    return {
      jobId,
      status: "fail",
      branch,
      headSha: r.headSha,
      pushed: false,
      nothingToCommit: r.nothingToCommit,
      commitsAhead: r.commitsAhead,
      summary: `branch history diverged from ${base}; cannot auto-integrate on ${branch} (the branch likely needs rebuilding from ${base})`,
    };
  }
  return {
    jobId,
    status: "ok",
    branch,
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
      : `committed ${r.headSha.slice(0, 7)} and pushed ${branch}`,
  };
}

/**
 * Map a `backupPush` result onto the `PushResult`: the run's committed HEAD was force-pushed to a
 * durable WIP ref with no base merge and no PR, so the work is preserved before the worktree is reaped.
 */
export function resolveBackupOutcome(r: BackupPushResult, job: BackupOutcomeContext): PushResultWithWip {
  return {
    jobId: job.jobId,
    status: "ok",
    branch: job.branch,
    headSha: r.headSha,
    pushed: r.pushed,
    nothingToCommit: r.nothingToCommit,
    wipRef: r.wipRef,
    summary: `backup: preserved ${r.headSha.slice(0, 7)} on ${r.wipRef} (no base merge, no PR)`,
  };
}
