/**
 * The push-outcome ladder (DHK-264 / DHK-318), extracted from `stage-runner.runPush` so the
 * deliver/backup/conflict/diverged/noop decision is a pure function with no git, filesystem, or network
 * reach. These pin every branch of the ladder - the status, the forwarded git fields, the PR fields, and
 * the exact human summaries the hub reads - which were previously reachable only through a full push run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { BackupPushResult, CommitPushResult, OpenPrResult } from "@dahrk/executor-worktree";
import { resolveBackupOutcome, resolveDeliverOutcome } from "../src/push-outcome.js";

const deliverCtx = { jobId: "job-1", branch: "dahrk/run-7", base: "main" };

/** A clean `commitAndPush` result; override per case. */
const commit = (over: Partial<CommitPushResult> = {}): CommitPushResult => ({
  headSha: "abcdef1234567890",
  pushed: true,
  nothingToCommit: false,
  commitsAhead: 2,
  ...over,
});

test("deliver noop: the delta is empty/scratch-only, so it is a successful no-op - nothing pushed, no integration, no PR", () => {
  const r = resolveDeliverOutcome(commit({ integration: "noop", pushed: false, nothingToCommit: true }), deliverCtx, undefined);
  assert.equal(r.status, "ok");
  assert.equal(r.pushed, false);
  assert.equal(r.nothingToCommit, true);
  assert.equal(r.commitsAhead, 2);
  assert.equal(r.integration, undefined, "noop is conveyed as an absent integration");
  assert.equal(r.summary, "no changes to deliver on dahrk/run-7 - work already present on main");
});

test("deliver conflict: base advanced and merging it conflicted - still ok (a real outcome), forwards integration + conflictFiles", () => {
  const r = resolveDeliverOutcome(
    commit({ integration: "conflict", pushed: false, conflictFiles: ["src/a.ts", "src/b.ts"] }),
    deliverCtx,
    undefined,
  );
  assert.equal(r.status, "ok");
  assert.equal(r.pushed, false);
  assert.equal(r.integration, "conflict");
  assert.deepEqual(r.conflictFiles, ["src/a.ts", "src/b.ts"]);
  assert.equal(r.summary, "base advanced; merge conflict on dahrk/run-7 (manual merge needed)");
});

test("deliver conflict without conflictFiles: the field is omitted, not set to undefined", () => {
  const r = resolveDeliverOutcome(commit({ integration: "conflict", pushed: false }), deliverCtx, undefined);
  assert.equal(r.integration, "conflict");
  assert.ok(!("conflictFiles" in r), "conflictFiles is absent when the primitive did not report them");
});

test("deliver diverged: unrelated history cannot auto-integrate - a real fail, not an ok conflict", () => {
  const r = resolveDeliverOutcome(commit({ integration: "diverged", pushed: false }), deliverCtx, undefined);
  assert.equal(r.status, "fail");
  assert.equal(r.pushed, false);
  assert.equal(r.integration, undefined, "diverged is not forwarded as an integration outcome");
  assert.match(r.summary, /branch history diverged from main; cannot auto-integrate on dahrk\/run-7/);
});

test("deliver clean with an opened PR: forwards integration + the PR url/number", () => {
  const pr: OpenPrResult = { prUrl: "https://gh/pr/9", prNumber: 9 };
  const r = resolveDeliverOutcome(commit({ integration: "clean" }), deliverCtx, pr);
  assert.equal(r.status, "ok");
  assert.equal(r.pushed, true);
  assert.equal(r.integration, "clean");
  assert.equal(r.prUrl, "https://gh/pr/9");
  assert.equal(r.prNumber, 9);
  assert.ok(!("prError" in r));
  assert.equal(r.summary, "committed abcdef1 and pushed dahrk/run-7");
});

test("deliver clean with a non-fatal PR error: forwards prError, no url/number", () => {
  const pr: OpenPrResult = { prError: "gh not authenticated" };
  const r = resolveDeliverOutcome(commit({ integration: "clean" }), deliverCtx, pr);
  assert.equal(r.status, "ok");
  assert.equal(r.prError, "gh not authenticated");
  assert.ok(!("prUrl" in r), "no prUrl when the PR did not open");
  assert.ok(!("prNumber" in r));
});

test("deliver clean with no PR requested: no PR fields at all", () => {
  const r = resolveDeliverOutcome(commit({ integration: "clean" }), deliverCtx, undefined);
  assert.ok(!("prUrl" in r) && !("prNumber" in r) && !("prError" in r));
});

test("deliver absent integration (legacy push-only path) is treated as clean", () => {
  const r = resolveDeliverOutcome(commit({ integration: undefined }), deliverCtx, undefined);
  assert.equal(r.status, "ok");
  assert.equal(r.pushed, true);
  assert.ok(!("integration" in r), "no integration field when the primitive reported none");
  assert.equal(r.summary, "committed abcdef1 and pushed dahrk/run-7");
});

test("deliver clean, nothing to commit but a ref pushed: the 'branch pushed' summary", () => {
  const r = resolveDeliverOutcome(commit({ integration: "clean", nothingToCommit: true, pushed: true }), deliverCtx, undefined);
  assert.equal(r.summary, "no changes to commit; branch pushed");
});

test("deliver clean, nothing to commit and nothing pushed: the 'nothing pushed' summary", () => {
  const r = resolveDeliverOutcome(commit({ integration: "clean", nothingToCommit: true, pushed: false }), deliverCtx, undefined);
  assert.equal(r.summary, "no changes to commit; nothing pushed");
});

test("backup: the run's HEAD was preserved on a durable WIP ref, no base merge, no PR", () => {
  const r: BackupPushResult = { headSha: "0123456789abcdef", pushed: true, nothingToCommit: false, wipRef: "dahrk/wip/run-7" };
  const result = resolveBackupOutcome(r, { jobId: "job-2", branch: "dahrk/run-7" });
  assert.equal(result.jobId, "job-2");
  assert.equal(result.status, "ok");
  assert.equal(result.branch, "dahrk/run-7");
  assert.equal(result.headSha, "0123456789abcdef");
  assert.equal(result.pushed, true);
  assert.equal(result.wipRef, "dahrk/wip/run-7");
  assert.equal(result.summary, "backup: preserved 0123456 on dahrk/wip/run-7 (no base merge, no PR)");
});
