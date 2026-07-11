/**
 * Reaper tests (DHK-371). Real git, real dirs, no network.
 *
 * The property that matters most is RESTART-SAFETY: the reaper must collect worktrees created by a
 * previous process. The retention pass it replaces consulted an in-memory map, so after a restart every
 * pre-existing worktree was orphaned for ever - which is how one node reached 92 worktrees and 65 GB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitService } from "../src/git-service.js";
import { createWorktreeReaper } from "../src/worktree-reaper.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8" });

function makeBareRemote(): string {
  const remote = mkdtempSync(join(tmpdir(), "dahrk-remote-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  const seed = mkdtempSync(join(tmpdir(), "dahrk-seed-"));
  try {
    git(seed, ["clone", remote, "."]);
    git(seed, ["config", "user.email", "harness@dahrk.test"]);
    git(seed, ["config", "user.name", "Dahrk"]);
    writeFileSync(join(seed, "README.md"), "# fixture\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "initial"]);
    git(seed, ["push", "origin", "HEAD:main"]);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
  return remote;
}

/** Backdate a worktree's durable last-used clock (`.skakel/scratch/state.json`) by `ms`. */
function ageBy(worktreePath: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  const state = join(worktreePath, ".skakel", "scratch", "state.json");
  mkdirSync(join(worktreePath, ".skakel", "scratch"), { recursive: true });
  if (!existsSync(state)) writeFileSync(state, "{}\n");
  utimesSync(state, t, t);
  utimesSync(worktreePath, t, t);
}

const HOUR = 3_600_000;

test("the reaper collects a BROKEN worktree and frees the branch name it was holding hostage", async () => {
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const mirror = join(mirrorsDir, "repo-r1");
  try {
    const ref = await svc.createWorktree({
      repoId: "repo-r1",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-broken",
      branch: "skakel/issue-DHK-1",
    });
    // Reproduce the corpse: branch ref deleted under a worktree that was never torn down. HEAD is now
    // unborn, so the worktree is unusable, yet it goes on claiming the branch name for ever.
    git(mirror, ["update-ref", "-d", "refs/heads/skakel/issue-DHK-1"]);
    ageBy(ref.worktreePath, 2 * HOUR); // past the activity grace

    const reaper = createWorktreeReaper({ worktreesDir, mirrorsDir });
    const report = await reaper.reap();

    assert.equal(report.reaped.length, 1);
    assert.equal(report.reaped[0]?.reason, "broken");
    assert.ok(!existsSync(ref.worktreePath), "the broken worktree directory is gone");
    const claims = git(mirror, ["worktree", "list", "--porcelain"]);
    assert.ok(!claims.includes("skakel/issue-DHK-1"), "and its branch claim is gone with it");
  } finally {
    for (const d of [remote, worktreesDir, mirrorsDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("the reaper is RESTART-SAFE: a fresh instance collects worktrees a previous process created", async () => {
  // This is the property the old in-memory retention lacked, and the direct cause of the 65 GB leak.
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  try {
    // "Previous process": build worktrees through one service instance, then drop every reference to it.
    const old = createGitService({ worktreesDir, mirrorsDir });
    const refs = [];
    for (const n of [1, 2, 3]) {
      refs.push(
        await old.createWorktree({
          repoId: "repo-r2",
          gitUrl: remote,
          baseBranch: "main",
          runId: `run-old-${n}`,
          branch: `skakel/issue-DHK-${n}`,
        }),
      );
    }
    for (const r of refs) ageBy(r.worktreePath, 12 * HOUR);

    // "New process": a reaper with no memory of any of it.
    const reaper = createWorktreeReaper({ worktreesDir, mirrorsDir });
    const report = await reaper.reap({ maxIdleMs: 6 * HOUR });

    assert.equal(report.reaped.length, 3, "all three are collected despite the process having no memory of them");
    for (const r of refs) assert.ok(!existsSync(r.worktreePath));
  } finally {
    for (const d of [remote, worktreesDir, mirrorsDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("the reaper never touches a busy run, nor one inside the activity grace", async () => {
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  try {
    const busyRef = await svc.createWorktree({
      repoId: "repo-r3",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-busy",
      branch: "skakel/issue-DHK-7",
    });
    const freshRef = await svc.createWorktree({
      repoId: "repo-r3",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-fresh",
      branch: "skakel/issue-DHK-8",
    });
    // Busy AND old: still must not be touched (a live stage owns it).
    ageBy(busyRef.worktreePath, 99 * HOUR);
    // Fresh: inside the grace, so it may belong to a live run in ANOTHER process (there is no IPC).
    ageBy(freshRef.worktreePath, 0);

    const reaper = createWorktreeReaper({
      worktreesDir,
      mirrorsDir,
      isBusy: (id) => id === "run-busy",
    });
    const report = await reaper.reap({ maxIdleMs: 1 });

    assert.equal(report.reaped.length, 0, "neither is collected");
    assert.equal(report.skipped, 2);
    assert.ok(existsSync(busyRef.worktreePath), "the busy run's worktree survives");
    assert.ok(existsSync(freshRef.worktreePath), "and so does the one inside the activity grace");
  } finally {
    for (const d of [remote, worktreesDir, mirrorsDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("dryRun reports what it would collect and deletes nothing", async () => {
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  try {
    const ref = await svc.createWorktree({
      repoId: "repo-r4",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-dry",
      branch: "skakel/issue-DHK-11",
    });
    ageBy(ref.worktreePath, 12 * HOUR);

    const reaper = createWorktreeReaper({ worktreesDir, mirrorsDir });
    const report = await reaper.reap({ maxIdleMs: 6 * HOUR, dryRun: true });

    assert.equal(report.reaped.length, 1, "it reports the candidate");
    assert.ok(existsSync(ref.worktreePath), "but changes nothing on disk");
  } finally {
    for (const d of [remote, worktreesDir, mirrorsDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("over the count cap, the idlest worktrees go first", async () => {
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  try {
    const refs = [];
    for (const n of [1, 2, 3]) {
      refs.push(
        await svc.createWorktree({
          repoId: "repo-r5",
          gitUrl: remote,
          baseBranch: "main",
          runId: `run-c${n}`,
          branch: `skakel/issue-DHK-2${n}`,
        }),
      );
    }
    // All past the grace, none past the idle cap; distinct ages so ordering is deterministic.
    ageBy(refs[0]!.worktreePath, 5 * HOUR);
    ageBy(refs[1]!.worktreePath, 3 * HOUR);
    ageBy(refs[2]!.worktreePath, 1 * HOUR);

    const reaper = createWorktreeReaper({ worktreesDir, mirrorsDir });
    const report = await reaper.reap({ maxRuns: 2, maxIdleMs: 24 * HOUR });

    assert.equal(report.reaped.length, 1);
    assert.equal(report.reaped[0]?.runId, "run-c1", "the idlest is evicted");
    assert.equal(report.reaped[0]?.reason, "over-count");
    assert.ok(!existsSync(refs[0]!.worktreePath));
    assert.ok(existsSync(refs[1]!.worktreePath) && existsSync(refs[2]!.worktreePath));
  } finally {
    for (const d of [remote, worktreesDir, mirrorsDir]) rmSync(d, { recursive: true, force: true });
  }
});
