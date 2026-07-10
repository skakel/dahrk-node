/**
 * GitService tests against a REAL throwaway git repo (no network, no Docker). The node clones the
 * repo on demand from its gitUrl into a per-repo bare mirror cache, then adds a per-run worktree off
 * the mirror. git accepts a local path as a clone URL, so the "remote" here is a local repo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceRef } from "@dahrk/contracts";
import { createGitService, resolveWorktreesDir, sanitizeBranchName, parseOwnerRepo } from "../src/git-service.js";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8" });

/** A throwaway source repo that stands in for the remote gitUrl. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-src-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "core.hooksPath", "/dev/null"]); // no global hooks on the fixture
  git(dir, ["config", "user.email", "harness@dahrk.test"]);
  git(dir, ["config", "user.name", "Dahrk"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

/** A throwaway BARE repo that stands in for a pushable remote, seeded with one commit on main.
 *  When `gitignore` is given it is committed as the repo's `.gitignore` (e.g. the harness repo, which
 *  ignores its own `.skakel/scratch/`). */
function makeBareRemote(gitignore?: string): string {
  const remote = mkdtempSync(join(tmpdir(), "dahrk-remote-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  const seed = mkdtempSync(join(tmpdir(), "dahrk-seed-"));
  try {
    git(seed, ["clone", remote, "."]);
    git(seed, ["config", "user.email", "harness@dahrk.test"]);
    git(seed, ["config", "user.name", "Dahrk"]);
    writeFileSync(join(seed, "README.md"), "# fixture\n");
    if (gitignore !== undefined) writeFileSync(join(seed, ".gitignore"), gitignore);
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "initial"]);
    git(seed, ["push", "origin", "HEAD:main"]);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
  return remote;
}

/** Advance the bare remote's `main` by one commit (a parallel run that landed first): clone, write
 *  `file`, commit, push back to main. Stands in for "the base moved after our worktree was created". */
function advanceRemoteMain(remote: string, file: string, content: string, message: string): void {
  const seed = mkdtempSync(join(tmpdir(), "dahrk-adv-"));
  try {
    git(seed, ["clone", remote, "."]);
    git(seed, ["config", "user.email", "harness@dahrk.test"]);
    git(seed, ["config", "user.name", "Dahrk"]);
    writeFileSync(join(seed, file), content);
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", message]);
    git(seed, ["push", "origin", "HEAD:main"]);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
}

/** Push a branch to the bare remote whose root commit is UNRELATED to `main` (an orphan history, no
 *  shared ancestor). Stands in for a per-issue branch that predates a base rewrite / was created empty
 *  and grew its own root - the shape that makes a push-time base merge refuse `unrelated histories`. */
function pushUnrelatedBranch(remote: string, branch: string): void {
  const seed = mkdtempSync(join(tmpdir(), "dahrk-orphan-"));
  try {
    git(seed, ["clone", remote, "."]);
    git(seed, ["config", "user.email", "harness@dahrk.test"]);
    git(seed, ["config", "user.name", "Dahrk"]);
    git(seed, ["checkout", "--orphan", "orphan-tmp"]);
    git(seed, ["rm", "-rf", "--cached", "."]); // drop main's tree from the index so the root is clean
    writeFileSync(join(seed, "ORPHAN.md"), "# unrelated root\n");
    git(seed, ["add", "ORPHAN.md"]);
    git(seed, ["commit", "-m", "unrelated root"]);
    git(seed, ["push", "origin", `HEAD:refs/heads/${branch}`]);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
}

test("sanitizeBranchName produces a valid ref", () => {
  assert.equal(sanitizeBranchName("skakel/run A..b"), "skakel/run-A.b");
});

test("parseOwnerRepo handles SSH and HTTPS git URLs and rejects non-URLs", () => {
  assert.equal(parseOwnerRepo("git@github.com:dahrkai/dahrk-node.git"), "dahrkai/dahrk-node");
  assert.equal(parseOwnerRepo("https://github.com/dahrkai/dahrk-node.git"), "dahrkai/dahrk-node");
  assert.equal(parseOwnerRepo("https://github.com/dahrkai/dahrk-node"), "dahrkai/dahrk-node");
  assert.equal(parseOwnerRepo("not-a-url"), undefined);
});

test("resolveWorktreesDir single-sources the base the service exposes for hello advertisement", () => {
  const saved = { d: process.env.DAHRK_WORKTREES_DIR, s: process.env.SKAKEL_WORKTREES_DIR };
  try {
    delete process.env.DAHRK_WORKTREES_DIR;
    delete process.env.SKAKEL_WORKTREES_DIR;
    // Explicit override wins and is exactly what the service exposes (what the client advertises).
    assert.equal(resolveWorktreesDir("/custom/wt"), "/custom/wt");
    assert.equal(createGitService({ worktreesDir: "/custom/wt", mirrorsDir: "/tmp/none" }).worktreesDir, "/custom/wt");
    // Env override is honoured.
    process.env.DAHRK_WORKTREES_DIR = "/env/wt";
    assert.equal(resolveWorktreesDir(), "/env/wt");
    // Default falls back under the home dir.
    delete process.env.DAHRK_WORKTREES_DIR;
    assert.match(resolveWorktreesDir(), /[/\\]\.dahrk[/\\]worktrees$/);
  } finally {
    if (saved.d === undefined) delete process.env.DAHRK_WORKTREES_DIR;
    else process.env.DAHRK_WORKTREES_DIR = saved.d;
    if (saved.s === undefined) delete process.env.SKAKEL_WORKTREES_DIR;
    else process.env.SKAKEL_WORKTREES_DIR = saved.s;
  }
});

test("openPrAmbient is non-fatal: an unparseable git URL yields a prError, never throws", async () => {
  // The ambient PR is best-effort. When owner/repo cannot be derived it must return a reason (so the
  // run stays green on the pushed branch), not throw and wedge the action.
  const svc = createGitService({ worktreesDir: "/tmp/none", mirrorsDir: "/tmp/none" });
  const ref: WorkspaceRef = {
    repoId: "r",
    gitUrl: "not-a-url",
    repo: "r",
    baseBranch: "main",
    worktreePath: "/tmp/none",
    scratchPath: "/tmp/none/.skakel",
  };
  const res = await svc.openPrAmbient(ref, { branch: "skakel/x", base: "main", title: "t", body: "b" });
  assert.equal(res.prUrl, undefined);
  assert.match(res.prError ?? "", /cannot derive owner\/repo/);
});

test("commitAndPush commits the worktree and pushes the per-issue branch to the remote", async () => {
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const branch = "skakel/issue-TEST-1";

  try {
    // First session: a fresh per-issue branch off main; the agent writes a file; we commit + push.
    const ref1 = await svc.createWorktree({
      repoId: "repo-pp",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-pp-1",
      branch,
    });
    assert.match(git(ref1.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), /^skakel\/issue-TEST-1$/);
    writeFileSync(join(ref1.worktreePath, "hello.txt"), "from session 1\n");
    // Engine-owned scratch in the worktree must NEVER be committed/pushed.
    writeFileSync(join(ref1.scratchPath, "state.json"), "{}\n");

    const r1 = await svc.commitAndPush(ref1, { message: "session 1", branch });
    assert.equal(r1.pushed, true);
    assert.equal(r1.nothingToCommit, false);

    // The harness stamps its own author/committer identity on the commit, independent of the
    // fixture repo's local git config (set to "Dahrk <harness@dahrk.test>" above). Default is
    // Dahrk <noreply@dahrk.ai>.
    assert.equal(
      git(remote, ["show", "-s", "--format=%an <%ae> | %cn <%ce>", branch]).trim(),
      "Dahrk <noreply@dahrk.ai> | Dahrk <noreply@dahrk.ai>",
    );

    // The bare remote now carries the branch with the file (the push landed).
    assert.doesNotThrow(() => git(remote, ["rev-parse", "--verify", branch]));
    assert.match(git(remote, ["show", `${branch}:hello.txt`]), /from session 1/);
    // ...but the scratch dir is excluded from the pushed tree.
    const tree = git(remote, ["ls-tree", "-r", "--name-only", branch]);
    assert.ok(!tree.split("\n").some((p) => p.startsWith(".skakel/scratch")), "scratch is not pushed");

    // Re-summon (a NEW session/run) continues the SAME branch: the worktree is created on it with the
    // prior commit present, not forked off main.
    const ref2 = await svc.createWorktree({
      repoId: "repo-pp",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-pp-2",
      branch,
    });
    assert.notEqual(ref2.worktreePath, ref1.worktreePath, "a distinct worktree per session");
    assert.ok(existsSync(join(ref2.worktreePath, "hello.txt")), "continuation sees the prior commit");

    // A second push advances the SAME branch on the remote.
    writeFileSync(join(ref2.worktreePath, "hello.txt"), "from session 2\n");
    const r2 = await svc.commitAndPush(ref2, { message: "session 2", branch });
    assert.equal(r2.pushed, true);
    assert.match(git(remote, ["show", `${branch}:hello.txt`]), /from session 2/);

    // A push with no changes commits nothing but still reports cleanly.
    const r3 = await svc.commitAndPush(ref2, { message: "noop", branch });
    assert.equal(r3.nothingToCommit, true);
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("commitAndPush honours the configured author/committer identity override", async () => {
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({
    worktreesDir,
    mirrorsDir,
    authorName: "Bot",
    authorEmail: "bot@example.test",
  });
  const branch = "dahrk/issue-TEST-override";

  try {
    const ref = await svc.createWorktree({
      repoId: "repo-id",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-id-1",
      branch,
    });
    writeFileSync(join(ref.worktreePath, "hello.txt"), "override\n");
    const r = await svc.commitAndPush(ref, { message: "override identity", branch });
    assert.equal(r.pushed, true);
    // The override reaches BOTH author and committer.
    assert.equal(
      git(remote, ["show", "-s", "--format=%an <%ae> | %cn <%ce>", branch]).trim(),
      "Bot <bot@example.test> | Bot <bot@example.test>",
    );
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("commitAndPush integrates an advanced base before pushing when the change is non-overlapping", async () => {
  // A parallel run landed on `main` AFTER this worktree was created (a different file). At push time
  // the base is refreshed and merged in: the merge is clean, so the push carries BOTH the integrated
  // base commit and this run's change - they no longer collide only when they reach main.
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const branch = "skakel/issue-TEST-clean";

  try {
    const ref = await svc.createWorktree({
      repoId: "repo-clean",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-clean-1",
      branch,
    });
    // The base advances on the remote (a different file) AFTER our worktree branched off it.
    advanceRemoteMain(remote, "base.txt", "from a parallel run\n", "parallel landed first");
    // Our run edits an unrelated file.
    writeFileSync(join(ref.worktreePath, "hello.txt"), "from this run\n");

    const r = await svc.commitAndPush(ref, { message: "this run", branch, base: "main" });
    assert.equal(r.integration, "clean");
    assert.equal(r.pushed, true);

    // The pushed branch carries BOTH the integrated base commit and this run's change.
    const tree = git(remote, ["ls-tree", "-r", "--name-only", branch]);
    assert.match(tree, /base\.txt/, "the advanced base commit was integrated and pushed");
    assert.match(tree, /hello\.txt/, "this run's change was pushed");
    assert.match(git(remote, ["show", `${branch}:base.txt`]), /from a parallel run/);
    assert.match(git(remote, ["show", `${branch}:hello.txt`]), /from this run/);
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("commitAndPush reports a conflict and pushes nothing when the advanced base overlaps", async () => {
  // The base advanced on the SAME file this run touched, so merging it in at push time conflicts. The
  // merge is aborted, nothing is pushed, and the conflict is reported so the hub can raise a
  // manual-merge elicitation instead of opening a phantom PR.
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const branch = "skakel/issue-TEST-conflict";

  try {
    const ref = await svc.createWorktree({
      repoId: "repo-conflict",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-conflict-1",
      branch,
    });
    // The base advances on README.md (which exists at the merge base) AFTER our worktree branched.
    advanceRemoteMain(remote, "README.md", "# remote change\n", "parallel edited README");
    // Our run edits the SAME file differently.
    writeFileSync(join(ref.worktreePath, "README.md"), "# this run's change\n");

    const r = await svc.commitAndPush(ref, { message: "this run", branch, base: "main" });
    assert.equal(r.integration, "conflict");
    assert.equal(r.pushed, false);
    assert.ok(r.conflictFiles?.includes("README.md"), "the conflicted path is reported");

    // Nothing was pushed: the branch never appeared on the remote.
    assert.throws(() => git(remote, ["rev-parse", "--verify", branch]), "no branch was pushed on conflict");
    // The merge was aborted: the worktree is clean and there is no in-progress merge.
    assert.equal(git(ref.worktreePath, ["status", "--porcelain"]).trim(), "", "worktree left clean");
    assert.throws(
      () => git(ref.worktreePath, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]),
      "the merge was aborted (no MERGE_HEAD)",
    );
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("commitAndPush reports `diverged` (never a masked `merge --abort` error) on unrelated histories", async () => {
  // Regression for the DHK-256 failure: the run's branch shared no history with the base, so the
  // push-time `git merge FETCH_HEAD` refused ("unrelated histories") WITHOUT starting a merge (no
  // MERGE_HEAD). The old catch ran `git merge --abort` unconditionally, which threw "no merge to
  // abort" and MASKED the real cause as `push failed: Command failed: git merge --abort`. This must
  // now surface as an explicit `diverged` outcome, push nothing, and leave no half-merge behind.
  const remote = makeBareRemote();
  pushUnrelatedBranch(remote, "skakel/issue-DIVERGED");
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const branch = "skakel/issue-DIVERGED";

  try {
    // createWorktree checks out the existing (unrelated-history) per-issue branch from the mirror.
    const ref = await svc.createWorktree({
      repoId: "repo-diverged",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-diverged-1",
      branch,
    });
    writeFileSync(join(ref.worktreePath, "ORPHAN.md"), "# this run's change\n");

    // Must NOT throw (the old masking bug threw here). Must report `diverged`.
    const r = await svc.commitAndPush(ref, { message: "this run", branch, base: "main" });
    assert.equal(r.integration, "diverged", "unrelated histories are reported as diverged");
    assert.equal(r.pushed, false, "nothing is pushed when the base cannot integrate");

    // No merge was left in progress (we never started or aborted one).
    assert.throws(
      () => git(ref.worktreePath, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]),
      "no half-merge is left behind",
    );
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("commitAndPush reports `noop` and pushes nothing when the branch adds nothing over an advanced base", async () => {
  // DHK-318: every stage found the work already merged and made no code change, so the branch's own
  // delta over the (advanced) base is empty. This must close as an explicit `noop` - nothing pushed,
  // no PR - rather than fast-forwarding to base and opening a phantom, zero-diff PR.
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const branch = "skakel/issue-TEST-noop";

  try {
    const ref = await svc.createWorktree({
      repoId: "repo-noop",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-noop-1",
      branch,
    });
    // The base advances on the remote after our worktree branched, but this run makes NO code change
    // (its only footprint is engine scratch, which never commits).
    advanceRemoteMain(remote, "base.txt", "from a parallel run\n", "parallel landed first");
    writeFileSync(join(ref.scratchPath, "state.json"), "{}\n");

    const r = await svc.commitAndPush(ref, { message: "this run", branch, base: "main" });
    assert.equal(r.integration, "noop", "an empty branch delta is an explicit no-op");
    assert.equal(r.pushed, false, "nothing is pushed when there is nothing to deliver");
    assert.equal(r.nothingToCommit, true);
    assert.equal(r.conflictFiles, undefined, "a no-op carries no conflictFiles");
    assert.throws(() => git(remote, ["rev-parse", "--verify", branch]), "no branch was pushed on a no-op");
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("commitAndPush reports `noop` when the branch's only committed delta is a git-ignored scratch path", async () => {
  // Belt-and-braces for DHK-318, independent of the harness-side gitignore fix: a prompt regression
  // force-commits a stray scratch file that the target repo git-ignores. The branch's only delta over
  // base is that ignored path, so delivery is a clean no-op - the stray file can never turn a push into
  // a base-advanced merge conflict.
  const remote = makeBareRemote("scratch.log\n");
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const branch = "skakel/issue-TEST-scratch-noop";

  try {
    const ref = await svc.createWorktree({
      repoId: "repo-scratch-noop",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-scratch-noop-1",
      branch,
    });
    // Force-commit a git-ignored scratch file (simulating a prompt regression that bypassed the ignore).
    writeFileSync(join(ref.worktreePath, "scratch.log"), "stray planning scratch\n");
    git(ref.worktreePath, ["add", "-f", "scratch.log"]);
    git(ref.worktreePath, ["-c", "user.email=r@dahrk.test", "-c", "user.name=Regression", "commit", "-m", "stray scratch"]);

    const r = await svc.commitAndPush(ref, { message: "this run", branch, base: "main" });
    assert.equal(r.integration, "noop", "a scratch-only delta is a no-op");
    assert.equal(r.pushed, false, "the stray scratch file is not delivered");
    assert.throws(() => git(remote, ["rev-parse", "--verify", branch]), "no branch was pushed");
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("backupPush preserves the run's HEAD on a disposable wip ref with no base merge and no PR", async () => {
  // DHK-264: a `deliver` that hit a base-advanced conflict would leave nothing pushed and lose the
  // run's committed HEAD with the reaped worktree. `backupPush` force-pushes HEAD as-is to a throwaway
  // `dahrk/wip/<runId>` ref WITHOUT integrating the base, so the work is retrievable on origin.
  const remote = makeBareRemote();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const branch = "skakel/issue-BACKUP";
  const wipRef = "dahrk/wip/run-backup-1";

  try {
    const ref = await svc.createWorktree({
      repoId: "repo-backup",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-backup-1",
      branch,
    });
    // The base advances on the SAME file this run touched: a deliver push would conflict and push
    // nothing. The backup push must ignore the base entirely and preserve HEAD regardless.
    advanceRemoteMain(remote, "README.md", "# remote change\n", "parallel edited README");
    writeFileSync(join(ref.worktreePath, "README.md"), "# this run's change\n");
    // Engine-owned scratch must never enter the preserved ref either.
    writeFileSync(join(ref.scratchPath, "state.json"), "{}\n");

    const r = await svc.backupPush(ref, { message: "preserve wip", branch: wipRef });
    assert.equal(r.pushed, true);
    assert.equal(r.nothingToCommit, false);
    assert.equal(r.wipRef, wipRef);
    assert.equal(r.headSha, git(ref.worktreePath, ["rev-parse", "HEAD"]).trim(), "returns the preserved sha");

    // The wip ref exists on the remote and carries THIS run's HEAD, verbatim - no base merge.
    assert.doesNotThrow(() => git(remote, ["rev-parse", "--verify", wipRef]));
    assert.equal(git(remote, ["rev-parse", wipRef]).trim(), r.headSha, "the wip ref points at the preserved sha");
    assert.match(git(remote, ["show", `${wipRef}:README.md`]), /this run's change/);
    const tree = git(remote, ["ls-tree", "-r", "--name-only", wipRef]);
    assert.ok(!tree.split("\n").some((p) => p.startsWith(".skakel/scratch")), "scratch is excluded from the wip ref");
    // No PR was opened and the per-issue branch was NOT pushed (backup only touches the wip ref).
    assert.throws(() => git(remote, ["rev-parse", "--verify", branch]), "the per-issue branch is untouched");

    // The wip ref is disposable: a second backup force-updates it to the new HEAD.
    writeFileSync(join(ref.worktreePath, "more.txt"), "further work\n");
    const r2 = await svc.backupPush(ref, { message: "preserve wip 2", branch: wipRef });
    assert.notEqual(r2.headSha, r.headSha, "a new commit advanced HEAD");
    assert.equal(git(remote, ["rev-parse", wipRef]).trim(), r2.headSha, "the wip ref was force-updated");

    // A no-op backup (nothing new to commit) still preserves the existing HEAD.
    const r3 = await svc.backupPush(ref, { message: "noop backup", branch: wipRef });
    assert.equal(r3.nothingToCommit, true);
    assert.equal(r3.headSha, r2.headSha);
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("commitAndPush succeeds when the target repo's own .gitignore ignores .skakel/scratch", async () => {
  // The harness repo (which Skakel dogfoods on) gitignores `.skakel/scratch/`. Naming scratch as an
  // explicit `:!.skakel/scratch` pathspec made `git add` fail ("paths are ignored ... use -f") and so
  // failed every push on such a repo. The worktree-local exclude + plain `git add -A` must handle it.
  const remote = makeBareRemote(".skakel/scratch/\n");
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const branch = "skakel/issue-TEST-2";

  try {
    const ref = await svc.createWorktree({
      repoId: "repo-ignore",
      gitUrl: remote,
      baseBranch: "main",
      runId: "run-ignore-1",
      branch,
    });
    writeFileSync(join(ref.worktreePath, "code.ts"), "export const x = 1;\n");
    writeFileSync(join(ref.scratchPath, "state.json"), "{}\n");

    // Previously this threw at `git add`; it must now stage real code and push cleanly.
    const r = await svc.commitAndPush(ref, { message: "ignored-scratch repo", branch });
    assert.equal(r.pushed, true);
    assert.equal(r.nothingToCommit, false);

    const tree = git(remote, ["ls-tree", "-r", "--name-only", branch]);
    assert.match(tree, /code\.ts/, "real code is pushed");
    assert.ok(!tree.split("\n").some((p) => p.startsWith(".skakel/scratch")), "scratch is still excluded");
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("createWorktree clones a mirror on first sight, adds a worktree, and teardown removes it", async () => {
  const src = makeRepo();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });

  try {
    const ref = await svc.createWorktree({
      repoId: "repo-gittest",
      gitUrl: src,
      baseBranch: "main",
      runId: "run-gittest-1",
    });
    // The registry identity threads through onto the ref (self-describing); `repo` defaults to repoId.
    assert.equal(ref.repoId, "repo-gittest");
    assert.equal(ref.gitUrl, src);
    assert.equal(ref.repo, "repo-gittest");
    assert.equal(ref.worktreePath, join(worktreesDir, "run-gittest-1"));
    assert.ok(existsSync(ref.worktreePath), "worktree dir exists");
    assert.ok(existsSync(ref.scratchPath), "scratch dir exists");

    // A bare mirror was cloned on demand, keyed by repoId.
    const mirror = join(mirrorsDir, "repo-gittest");
    assert.ok(existsSync(mirror), "mirror clone exists");
    assert.equal(git(mirror, ["rev-parse", "--is-bare-repository"]).trim(), "true", "mirror is bare");

    // It is a real git worktree on the skakel/<runId> branch, registered in the mirror.
    assert.match(git(ref.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), /^dahrk\/run-gittest-1$/);
    assert.ok(git(mirror, ["worktree", "list", "--porcelain"]).includes(ref.worktreePath), "mirror knows the worktree");

    // Re-create is idempotent (sticky owner / re-dispatch): same path, still valid.
    const again = await svc.createWorktree({ repoId: "repo-gittest", gitUrl: src, baseBranch: "main", runId: "run-gittest-1" });
    assert.equal(again.worktreePath, ref.worktreePath);

    await svc.teardownWorktree(ref);
    assert.equal(existsSync(ref.worktreePath), false, "worktree dir gone after teardown");
    assert.ok(!git(mirror, ["worktree", "list", "--porcelain"]).includes(ref.worktreePath), "pruned from the mirror");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("a brokered credentialToken clones cleanly and is never persisted to git config", async () => {
  const src = makeRepo();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const secret = "ghs_supersecrettoken";

  try {
    // A local path stands in for the https remote; the token rides GIT_ASKPASS, so the clone still
    // succeeds and we can assert the token never lands on disk in git's config or the worktree.
    const ref = await svc.createWorktree({
      repoId: "repo-cred",
      gitUrl: src,
      baseBranch: "main",
      runId: "run-cred-1",
      credentialToken: secret,
    });
    assert.ok(existsSync(ref.worktreePath), "worktree created with a credential token");

    const mirror = join(mirrorsDir, "repo-cred");
    const remoteUrl = git(mirror, ["config", "--get", "remote.origin.url"]).trim();
    assert.equal(remoteUrl.includes(secret), false, "token is not embedded in the remote URL");
    assert.equal(git(mirror, ["config", "--list"]).includes(secret), false, "token not in mirror git config");
    assert.equal(git(ref.worktreePath, ["config", "--list"]).includes(secret), false, "token not in worktree git config");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("createWorktree refuses to branch a NEW run from a stale base when the base cannot be refreshed", async () => {
  // a run branched from a mirror whose `main` lagged the remote by six commits and
  // re-implemented an already-merged fix. The refresh failure used to be swallowed and the run
  // branched off the stale cached base. Now a new run that cannot confirm a fresh base throws.
  const src = makeRepo();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });

  try {
    // Run 1 clones the mirror; the base resolves and the worktree builds.
    const ref1 = await svc.createWorktree({ repoId: "repo-stale", gitUrl: src, baseBranch: "main", runId: "run-stale-1" });
    assert.ok(existsSync(ref1.worktreePath), "first run builds off a freshly cloned mirror");

    // The remote becomes unreachable, so the mirror can no longer refresh or fetch its base.
    rmSync(src, { recursive: true, force: true });

    // A NEW run cannot confirm the cached base is current, so it fails loudly instead of silently
    // branching off a possibly-stale tree.
    await assert.rejects(
      svc.createWorktree({ repoId: "repo-stale", gitUrl: src, baseBranch: "main", runId: "run-stale-2" }),
      "a new run off an unrefreshable base must throw, not branch from stale",
    );
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("an ambient (tokenless) clone runs git with GIT_TERMINAL_PROMPT=0 so auth failures fail fast", async () => {
  // HAR-248: the tokenless path must also disable git's interactive credential prompt. When an ambient
  // node clones a repo the host cannot authenticate over HTTPS, git otherwise falls through to a
  // Username prompt that, under pm2/tsx (no TTY), dies with the confusing "could not read Username ...
  // Device not configured" instead of a clear auth failure. Rather than stand up an auth-challenging
  // server (needs network), we shim `git` on PATH to record the GIT_TERMINAL_PROMPT it was invoked
  // with on the clone, then delegate to the real git (the fixture is a local path, so no auth is
  // needed). Before the fix the tokenless clone passed no env and the flag was unset.
  const realGit = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
  const src = makeRepo();
  const shimDir = mkdtempSync(join(tmpdir(), "dahrk-shim-"));
  const captureFile = join(shimDir, "clone-terminal-prompt");
  const shim = join(shimDir, "git");
  // For `clone`, record the flag (or the literal UNSET) then exec the real git; pass everything else
  // straight through so the rest of createWorktree behaves exactly as normal.
  writeFileSync(
    shim,
    `#!/bin/sh\nif [ "$1" = "clone" ]; then printf '%s' "\${GIT_TERMINAL_PROMPT-UNSET}" > "${captureFile}"; fi\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });

  const savedPath = process.env.PATH;
  const savedPrompt = process.env.GIT_TERMINAL_PROMPT;
  process.env.PATH = `${shimDir}:${savedPath ?? ""}`;
  // Ensure the flag is not already set in the ambient env, so a captured "0" can only come from the fix.
  delete process.env.GIT_TERMINAL_PROMPT;
  try {
    const ref = await svc.createWorktree({
      repoId: "repo-ambient",
      gitUrl: src,
      baseBranch: "main",
      runId: "run-ambient-1",
    });
    assert.ok(existsSync(ref.worktreePath), "the ambient worktree still builds through the shim");
    assert.equal(
      readFileSync(captureFile, "utf-8"),
      "0",
      "the tokenless clone must run git with GIT_TERMINAL_PROMPT=0",
    );
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
    else process.env.GIT_TERMINAL_PROMPT = savedPrompt;
    rmSync(src, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});

test("a second run reuses the mirror and picks up new commits via remote update --prune", async () => {
  const src = makeRepo();
  const worktreesDir = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const mirrorsDir = mkdtempSync(join(tmpdir(), "dahrk-mir-"));
  const svc = createGitService({ worktreesDir, mirrorsDir });
  const mirror = join(mirrorsDir, "repo-r");

  try {
    const ref1 = await svc.createWorktree({ repoId: "repo-r", gitUrl: src, baseBranch: "main", runId: "run-1" });
    assert.ok(existsSync(mirror), "mirror cloned on first run");
    assert.equal(existsSync(join(ref1.worktreePath, "SECOND.md")), false, "the new file does not exist yet");

    // Advance the source's main branch after the mirror was cloned.
    writeFileSync(join(src, "SECOND.md"), "second\n");
    git(src, ["add", "."]);
    git(src, ["commit", "-m", "second"]);

    // A second run reuses the SAME mirror dir (no re-clone) and refreshes it, so the new commit shows.
    const ref2 = await svc.createWorktree({ repoId: "repo-r", gitUrl: src, baseBranch: "main", runId: "run-2" });
    assert.notEqual(ref2.worktreePath, ref1.worktreePath, "a distinct worktree per run");
    assert.match(git(ref2.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), /^dahrk\/run-2$/);
    assert.ok(existsSync(join(ref2.worktreePath, "SECOND.md")), "the refreshed mirror brought the new commit");
    // Both runs' worktrees coexist off the one mirror.
    const list = git(mirror, ["worktree", "list", "--porcelain"]);
    assert.ok(list.includes(ref1.worktreePath) && list.includes(ref2.worktreePath), "both worktrees live in the mirror");
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(mirrorsDir, { recursive: true, force: true });
  }
});
