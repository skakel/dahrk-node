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

/** Backdate a worktree's durable last-used clock (`.dahrk/scratch/state.json`) by `ms`. */
function ageBy(worktreePath: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  const state = join(worktreePath, ".dahrk", "scratch", "state.json");
  mkdirSync(join(worktreePath, ".dahrk", "scratch"), { recursive: true });
  if (!existsSync(state)) writeFileSync(state, "{}\n");
  utimesSync(state, t, t);
  utimesSync(worktreePath, t, t);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Park a tip under `refs/dahrk/salvage/*` exactly as `salvageOrphanedTip` does, and return the ref. */
function parkSalvageRef(mirror: string, branchName: string, sha: string): string {
  const ref = `refs/dahrk/salvage/${branchName}/${sha.slice(0, 12)}`;
  git(mirror, ["update-ref", ref, sha]);
  return ref;
}

/** Backdate a loose salvage ref's own write time (its park time) by `ms`. */
function ageRef(mirror: string, ref: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  utimesSync(join(mirror, ref), t, t);
}

const refExists = (mirror: string, ref: string): boolean =>
  existsSync(join(mirror, ref)) ||
  (() => {
    try {
      git(mirror, ["rev-parse", "--verify", "-q", ref]);
      return true;
    } catch {
      return false;
    }
  })();

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

test("the reaper expires a salvage ref parked longer ago than salvageTtlMs", async () => {
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const mirror = join(mirrorsDir, "repo-s1");
  try {
    const ref = await svc.createWorktree({
      repoId: "repo-s1",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-salv-1",
      branch: "skakel/issue-DHK-30",
    });
    const sha = git(mirror, ["rev-parse", "refs/remotes/origin/main"]).trim();
    const parked = parkSalvageRef(mirror, "skakel/issue-DHK-30", sha);
    ageRef(mirror, parked, 30 * DAY); // parked well past a 14-day TTL
    // Keep the worktree out of the way: it is inside the grace, so the worktree sweep leaves it alone.

    const reaper = createWorktreeReaper({ worktreesDir, mirrorsDir });
    const report = await reaper.reap({ salvageTtlMs: 14 * DAY });

    assert.ok(!refExists(mirror, parked), "the stale salvage ref is collected");
    assert.equal(report.salvagedRefs, 0, "and is not counted as still parked");
    assert.ok(existsSync(ref.worktreePath), "the live worktree is untouched by the salvage sweep");
  } finally {
    for (const d of [remote, worktreesDir, mirrorsDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("a freshly parked salvage ref survives and is counted (the insurance holds)", async () => {
  // The committerdate trap: a branch can point at a commit authored days ago, so ageing by commit date
  // would expire a just-parked ref at once. Ageing by PARK time must keep it.
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const mirror = join(mirrorsDir, "repo-s2");
  try {
    await svc.createWorktree({
      repoId: "repo-s2",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-salv-2",
      branch: "skakel/issue-DHK-31",
    });
    const sha = git(mirror, ["rev-parse", "refs/remotes/origin/main"]).trim();
    const parked = parkSalvageRef(mirror, "skakel/issue-DHK-31", sha);
    ageRef(mirror, parked, 1 * DAY); // parked recently, well inside a 14-day TTL

    const reaper = createWorktreeReaper({ worktreesDir, mirrorsDir });
    const report = await reaper.reap({ salvageTtlMs: 14 * DAY });

    assert.ok(refExists(mirror, parked), "the fresh salvage ref still resolves");
    assert.equal(report.salvagedRefs, 1, "and is counted as still parked");
  } finally {
    for (const d of [remote, worktreesDir, mirrorsDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("dryRun expires no salvage ref and still reports it as parked", async () => {
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const mirror = join(mirrorsDir, "repo-s3");
  try {
    await svc.createWorktree({
      repoId: "repo-s3",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-salv-3",
      branch: "skakel/issue-DHK-32",
    });
    const sha = git(mirror, ["rev-parse", "refs/remotes/origin/main"]).trim();
    const parked = parkSalvageRef(mirror, "skakel/issue-DHK-32", sha);
    ageRef(mirror, parked, 30 * DAY); // stale enough to expire, but dryRun must stay its hand

    const reaper = createWorktreeReaper({ worktreesDir, mirrorsDir });
    const report = await reaper.reap({ salvageTtlMs: 14 * DAY, dryRun: true });

    assert.ok(refExists(mirror, parked), "dryRun deletes nothing");
    assert.equal(report.salvagedRefs, 1, "and still reports the ref as parked");
  } finally {
    for (const d of [remote, worktreesDir, mirrorsDir]) rmSync(d, { recursive: true, force: true });
  }
});
