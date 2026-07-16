/**
 * GitService - clone-on-demand worktree lifecycle. Adapted from cyrus's
 * `packages/edge-worker/src/GitService.ts` (the worktree git plumbing and
 * `sanitizeBranchName`), stripped of the cyrus-core / Issue / Workspace / Graphite
 * coupling. Pure git/node; we own it, zero cyrus npm deps.
 *
 * The node needs no pre-cloned repo. It keeps a per-repo **bare mirror cache** keyed by
 * `repoId` under a mirrors dir: on first sight of a repo it `git clone --mirror <gitUrl>`; on later
 * jobs it `git -C mirror remote update --prune`. One worktree per run is added off the mirror on a
 * fresh `dahrk/<runId>` branch, under a configurable worktrees dir. The `.skakel/scratch` directory
 * is created here; its `state.json` is written by the edge stage runner (tenant/run/stage context).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { WorkspaceRef } from "@dahrk/contracts";

/** Minimal logger; defaults to a no-op so the library is quiet in tests. */
export interface GitLogger {
  info(msg: string): void;
  warn(msg: string): void;
}
const noopLogger: GitLogger = { info: () => {}, warn: () => {} };

/** The engine-owned scratch dir (state.json, traces, issue.md): runtime state that lives in the
 *  worktree for stages to read/write but must NEVER enter a commit or the PR. Excluded from git and
 *  untracked before every push; also the yardstick for the "nothing to deliver" no-op below. */
const SCRATCH_DIR = ".skakel/scratch";

/** Everything the node needs to build a worktree with no local repo config: the registry identity
 *  (`repoId`/`gitUrl`) it clones on demand, the base branch, and the run it is for. `repo` is the
 *  logical name carried onto the ref (defaults to `repoId`). */
export interface WorktreeSpec {
  repoId: string;
  gitUrl: string;
  baseBranch: string;
  runId: string;
  /** Logical repo name for the returned ref (policy/display); defaults to `repoId`. */
  repo?: string;
  /**
   * Stable branch to check out (continuation) or create for this run; defaults to the legacy
   * per-session `dahrk/<runId>`. When it already exists on the remote (folded into the mirror by the
   * refresh), the worktree is created ON it so a re-summon sees the prior commits; otherwise it is
   * branched from `baseBranch` under this name.
   */
  branch?: string;
  /**
   * Optional ref to seed the worktree from, taking precedence over both the remote branch and the base.
   * Used to re-enter a run from work preserved by an earlier backup push (DHK-264), so a retry resumes
   * from the committed WIP rather than starting over from the base. Ignored when it does not resolve.
   */
  seedRef?: string;
  /**
   * Short-lived git credential brokered by the hub for this job, used only to clone/fetch
   * over HTTPS. Delivered to git via a transient `GIT_ASKPASS` helper outside the worktree, never on
   * the command line and never persisted to `git config` - so the agent that later runs in the
   * worktree cannot see it. Absent on ambient-mode nodes (host credentials are used instead).
   */
  credentialToken?: string;
}

/** Options for {@link GitService.commitAndPush}. */
export interface CommitPushOpts {
  /** The commit message (composed deterministically by the hub from stage summaries). */
  message: string;
  /** The branch to push HEAD to on the real remote. */
  branch: string;
  /** The base branch the branch is measured against, for the commits-ahead count. */
  base: string;
  /** Brokered HTTPS push token; absent = ambient host credentials are used. */
  credentialToken?: string;
}

/** Outcome of {@link GitService.commitAndPush}. */
export interface CommitPushResult {
  /** HEAD sha after the (possible) commit. */
  headSha: string;
  /** True if a ref was pushed to the remote. */
  pushed: boolean;
  /** True when the worktree had no changes to commit. */
  nothingToCommit: boolean;
  /** How many commits the branch is ahead of its base (`git rev-list --count base..HEAD`); 0 if
   *  the count could not be resolved (e.g. base not present locally). */
  commitsAhead: number;
  /** Outcome of merging the freshly fetched base into the branch before pushing. `conflict` means the
   *  merge started and hit content conflicts (aborted, nothing pushed); `diverged` means the merge
   *  could not even START - the branch and base share no common history (unrelated/diverged), so it can
   *  never auto-integrate and nothing was pushed; `noop` means the branch contributes nothing over the
   *  base (empty or scratch-only delta), so there was nothing to ship (nothing pushed, no PR); absent
   *  when integration was skipped (no base given, or the base fetch failed) so the legacy push-only path
   *  is treated as clean. */
  integration?: "clean" | "conflict" | "diverged" | "noop";
  /** The conflicted paths when `integration === "conflict"` (`git diff --name-only --diff-filter=U`). */
  conflictFiles?: string[];
}

/** Options for {@link GitService.backupPush}: a merge-free push of the run's HEAD to a disposable ref. */
export interface BackupPushOpts {
  /** Commit message for any pending (uncommitted) work captured before the backup push. */
  message: string;
  /** The disposable WIP ref to force-update with HEAD (e.g. `dahrk/wip/<runId>`). */
  branch: string;
  /** Brokered HTTPS push token; absent = ambient host credentials are used. */
  credentialToken?: string;
}

/** Outcome of {@link GitService.backupPush}. */
export interface BackupPushResult {
  /** HEAD sha after the (possible) commit - the sha now preserved on the WIP ref. */
  headSha: string;
  /** True if the WIP ref was force-updated on the remote. */
  pushed: boolean;
  /** True when the worktree had no uncommitted changes to commit before the push. */
  nothingToCommit: boolean;
  /** The ref HEAD was force-pushed to (echoes `opts.branch`, sanitised). */
  wipRef: string;
}

/**
 * The handle {@link GitService.reconcileInterrupted} needs: where the tree is, and where to push what
 * it finds there.
 *
 * Deliberately narrower than a full {@link WorkspaceRef} (to which it is structurally assignable, so a
 * live ref still passes). Boot reconciliation reconstructs this from the on-disk job ledger, long after
 * the process that held the real ref has died, and a full ref would force the ledger to carry `repoId`,
 * `repo`, `baseBranch` and `scratchPath` that nothing in this operation reads. Ask for what is used.
 */
export type InterruptedWorktree = Pick<WorkspaceRef, "worktreePath" | "gitUrl">;

/** Options for {@link GitService.reconcileInterrupted}: preserve an interrupted stage's uncommitted
 *  tail, then reset the worktree to its last commit. */
export interface ReconcileInterruptedOpts {
  /** Commit message for the preserved tail. */
  message: string;
  /** The disposable WIP ref the tail is pinned to, locally and (best-effort) on the remote. */
  branch: string;
  /** Brokered HTTPS push token; absent = ambient host credentials. */
  credentialToken?: string;
}

/** Outcome of {@link GitService.reconcileInterrupted}. */
export interface ReconcileInterruptedResult {
  /** True if the worktree had an uncommitted tail that had to be preserved and reset away. */
  dirty: boolean;
  /** The commit the worktree was reset back to: the last commit the agent actually completed. */
  headSha: string;
  /** The tail commit, when there was one. Reachable from `wipRef` locally whatever the push did. */
  tailSha?: string;
  /** The local (and, if `pushed`, remote) ref the tail was pinned to. */
  wipRef?: string;
  /** True if the tail also reached the remote. False is not a failure: the tail is safe locally. */
  pushed: boolean;
}

/** Options for {@link GitService.openPrAmbient}. */
export interface OpenPrOpts {
  /** The pushed branch to open the PR from. */
  branch: string;
  /** The base branch to target. */
  base: string;
  /** The PR title (composed deterministically by the hub). */
  title: string;
  /** The PR body (composed deterministically by the hub). */
  body: string;
}

/** Outcome of {@link GitService.openPrAmbient}: a PR ref on success, or a non-fatal `prError`. */
export interface OpenPrResult {
  /** The opened/existing PR's URL, when one was produced. */
  prUrl?: string;
  /** The opened/existing PR's number, when one was produced. */
  prNumber?: number;
  /** A non-fatal reason the PR could not be opened (gh missing/unauthed, API error). */
  prError?: string;
}

export interface GitService {
  /** Ensure the repo's mirror (clone-on-demand) and add a per-run worktree off it. */
  createWorktree(spec: WorktreeSpec): Promise<WorkspaceRef>;
  /**
   * Stage and commit the worktree changes (if any) and push HEAD to `opts.branch` on the REAL remote
   * (not `origin`/the local mirror). Deterministic side effect for the `open-pr` action; does no
   * inference. Pushes via the brokered token when given, else ambient host credentials.
   */
  commitAndPush(ref: WorkspaceRef, opts: CommitPushOpts): Promise<CommitPushResult>;
  /**
   * Merge-free work preservation (DHK-264): commit any pending work and force-push HEAD directly to
   * `opts.branch` (a disposable `dahrk/wip/<runId>` ref) on the REAL remote, WITHOUT fetching or merging
   * the base and WITHOUT opening a PR. Dispatched by the hub when a `deliver` push hit a base-advanced
   * conflict, so the run's committed HEAD is saved before its worktree is reaped (the merge that
   * `commitAndPush` does would abort and push nothing here). The WIP ref is disposable, so it is
   * force-updated. Returns the preserved sha and the ref it landed on.
   */
  backupPush(ref: WorkspaceRef, opts: BackupPushOpts): Promise<BackupPushResult>;
  /**
   * Ambient-node PR fallback: after a successful push, best-effort open (or reuse) the PR via the
   * host's `gh` CLI, using the host's ambient `gh` auth (or `GH_TOKEN`/`GITHUB_TOKEN`). Symmetric with
   * the ambient SSH push. Never throws: any failure (gh missing/unauthed, API error) is returned as
   * `prError`, leaving the already-pushed branch as the deliverable. Brokered nodes do not use this;
   * the hub opens their PR through the credential broker.
   */
  openPrAmbient(ref: WorkspaceRef, opts: OpenPrOpts): Promise<OpenPrResult>;
  /**
   * Make an interrupted run's worktree safe to reuse (DHK-416): preserve whatever the killed agent left
   * uncommitted, then hard-reset the tree back to its last commit.
   *
   * A node killed mid-stage leaves half-written files behind, and `createWorktree` REUSES an existing
   * worktree for the same runId, so the next dispatch would otherwise land an agent on top of a partial
   * edit. That is worse than starting clean: it can silently produce corrupt output that looks like work.
   *
   * Not `backupPush`, though it shares the same `commitPending` primitive, for two reasons that both
   * matter exactly here. `backupPush` leaves HEAD ADVANCED onto the tail commit, which is right when the
   * worktree is about to be reaped but wrong when it is about to be re-run - we need HEAD back at the
   * last good commit. And it THROWS when it cannot reach the remote, whereas boot reconciliation runs
   * before the socket is even up and must still produce a clean tree on a node that is offline. So the
   * push here is best-effort, and the tail is pinned to a LOCAL ref first: the work is never lost, even
   * when nothing can be pushed.
   */
  reconcileInterrupted(
    ref: InterruptedWorktree,
    opts: ReconcileInterruptedOpts,
  ): Promise<ReconcileInterruptedResult>;
  teardownWorktree(ref: WorkspaceRef): Promise<void>;
  /** The resolved absolute worktree base this service creates run worktrees under
   *  (`join(worktreesDir, runId)`). Exposed so the client can advertise it to the hub on `hello`, so
   *  the hub records each run's real worktree location instead of an advisory placeholder. */
  readonly worktreesDir: string;
}

/** Derive `owner/repo` from an SSH or HTTPS git URL, for `gh --repo` and compare links. */
export function parseOwnerRepo(gitUrl: string): string | undefined {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(gitUrl.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export interface GitServiceOptions {
  /** Where worktrees are created; one subdirectory per runId. */
  worktreesDir?: string;
  /** Where per-repo bare mirrors are cached; one subdirectory per repoId. */
  mirrorsDir?: string;
  /** Author/committer name for harness-made commits. Env: DAHRK_GIT_AUTHOR_NAME. */
  authorName?: string;
  /** Author/committer email for harness-made commits. Env: DAHRK_GIT_AUTHOR_EMAIL. */
  authorEmail?: string;
  /**
   * Whether a run is currently executing a stage on this node, keyed by runId. Consulted before evicting
   * a worktree that still claims the branch a new run wants: a live holder is a routing bug and must
   * surface as an error, not be stomped. Absent = nothing is busy (the safe default for a fresh process,
   * where no run can be mid-stage anyway).
   */
  isBusy?: (runId: string) => boolean;
  logger?: GitLogger;
}

/**
 * Sanitize a branch name to a valid git ref (cf. `git check-ref-format`): replace
 * invalid characters, collapse repeats, strip leading/trailing separators.
 */
export function sanitizeBranchName(name: string): string {
  if (!name) return name;
  return name
    .replace(/[`~^:?*[\]\\@{}\s]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/\.lock(\/|$)/g, "$1")
    .replace(/^[.\-/]+/, "")
    .replace(/[.\-/]+$/, "")
    .replace(/-{2,}/g, "-");
}

/**
 * Resolve the absolute worktree base a git service uses: an explicit override, else
 * `DAHRK_WORKTREES_DIR`/`SKAKEL_WORKTREES_DIR`, else `~/.dahrk/worktrees`. Exported so the client can
 * advertise the exact same base to the hub on `hello` (single source of truth with `createGitService`).
 */
export function resolveWorktreesDir(override?: string): string {
  return override ?? process.env.DAHRK_WORKTREES_DIR ?? process.env.SKAKEL_WORKTREES_DIR ?? join(homedir(), ".dahrk", "worktrees");
}

/**
 * Resolve the absolute per-repo bare-mirror base. Exported for the same reason as
 * {@link resolveWorktreesDir}: the reaper must reconcile against the SAME mirrors this service writes,
 * and a second copy of this fallback chain would silently drift.
 */
export function resolveMirrorsDir(override?: string): string {
  return override ?? process.env.DAHRK_MIRRORS_DIR ?? process.env.SKAKEL_MIRRORS_DIR ?? join(homedir(), ".dahrk", "mirrors");
}

export function createGitService(opts: GitServiceOptions = {}): GitService {
  const worktreesDir = resolveWorktreesDir(opts.worktreesDir);
  const mirrorsDir = resolveMirrorsDir(opts.mirrorsDir);
  const authorName = opts.authorName ?? process.env.DAHRK_GIT_AUTHOR_NAME ?? "Dahrk";
  const authorEmail = opts.authorEmail ?? process.env.DAHRK_GIT_AUTHOR_EMAIL ?? "noreply@dahrk.ai";
  const isBusy = opts.isBusy;
  const log = opts.logger ?? noopLogger;

  const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string =>
    execFileSync("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
      ...(env ? { env } : {}),
    });
  /** Run git with no cwd dependency (e.g. `clone`, which targets a not-yet-existing dir). */
  const gitBare = (args: string[], env?: NodeJS.ProcessEnv): string =>
    execFileSync("git", args, {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
      ...(env ? { env } : {}),
    });
  const gitOk = (cwd: string, args: string[]): boolean => {
    try {
      git(cwd, args);
      return true;
    } catch {
      return false;
    }
  };

  /** Run the `gh` CLI in `cwd`, returning stdout. Throws on non-zero exit or a missing binary. */
  const gh = (cwd: string, args: string[]): string =>
    execFileSync("gh", args, { cwd, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" });
  /** A human-readable reason from a failed `gh` invocation: ENOENT means gh is not installed; a
   *  non-zero exit carries its stderr (gh's "not authenticated"/API messages land there). */
  const ghError = (e: unknown): string => {
    const err = e as { code?: string; stderr?: string | Buffer; message?: string };
    if (err?.code === "ENOENT") return "gh CLI not installed on this node";
    const stderr = typeof err?.stderr === "string" ? err.stderr : err?.stderr?.toString();
    return (stderr?.trim() || err?.message || String(e)).split("\n")[0] ?? String(e);
  };

  /**
   * Exclude the engine-owned `.skakel/scratch` dir from git via the WORKTREE-LOCAL exclude file
   * (`$GIT_DIR/info/exclude`), not the target repo's tracked `.gitignore`. This makes a plain
   * `git add -A` silently skip scratch in EVERY repo the harness runs against - including one whose
   * own `.gitignore` already lists `.skakel/scratch/` (e.g. the harness repo itself), where naming
   * scratch as an explicit `:!.skakel/scratch` pathspec instead makes `git add` fail outright with
   * "The following paths are ignored ... use -f" and so fails the whole push. Idempotent and never
   * committed; best-effort (a write failure is non-fatal, the `git rm --cached` untrack still runs).
   */
  const excludeScratchLocally = (worktreePath: string): void => {
    const entry = `${SCRATCH_DIR}/`;
    try {
      const rel = git(worktreePath, ["rev-parse", "--git-path", "info/exclude"]).trim();
      const excludePath = isAbsolute(rel) ? rel : join(worktreePath, rel);
      const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
      if (existing.split("\n").some((l) => l.trim() === entry)) return;
      mkdirSync(dirname(excludePath), { recursive: true });
      const sep = existing && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(excludePath, `${existing}${sep}${entry}\n`);
    } catch (e) {
      log.warn(`could not set worktree scratch exclude at ${worktreePath}: ${(e as Error).message}`);
    }
  };

  /**
   * Stage everything except the engine-owned `.skakel/scratch` dir and commit iff something is staged.
   * Shared by the deliver push and the merge-free backup push. Untracks scratch if a prior commit
   * captured it, then `add -A` the rest; a commit is written only when the worktree is dirty (so a
   * no-op push commits nothing). Returns the resulting HEAD sha and whether a commit was made.
   */
  const commitPending = (worktreePath: string, message: string): { headSha: string; dirty: boolean } => {
    excludeScratchLocally(worktreePath);
    git(worktreePath, ["rm", "-r", "--cached", "--ignore-unmatch", "--quiet", SCRATCH_DIR]);
    git(worktreePath, ["add", "-A", "--", "."]);
    // Commit only when something is actually staged (`diff --cached --quiet` exits non-zero iff so).
    const dirty = !gitOk(worktreePath, ["diff", "--cached", "--quiet"]);
    if (dirty) {
      git(worktreePath, [
        "-c",
        `user.name=${authorName}`,
        "-c",
        `user.email=${authorEmail}`,
        "commit",
        "-m",
        message,
      ]);
    }
    return { headSha: git(worktreePath, ["rev-parse", "HEAD"]).trim(), dirty };
  };

  /**
   * Set up a transient `GIT_ASKPASS` helper that feeds the brokered token to git as the HTTPS
   * password, with the token held in the child env (never on the command line, never in git config).
   * The helper script lives in its own temp dir outside the worktree and is removed by `cleanup`; the
   * agent that later runs inside the worktree never sees it. This is the minimal credential proxy
   *; the localhost MCP gateway is.
   */
  const setupAuth = (token: string): { env: NodeJS.ProcessEnv; cleanup: () => void } => {
    const dir = mkdtempSync(join(tmpdir(), "dahrk-cred-"));
    const script = join(dir, "askpass.sh");
    // git calls GIT_ASKPASS with the prompt as $1; we always answer with the token. The username is
    // carried in the URL (x-access-token@...), so the password prompt is the only one that matters.
    writeFileSync(script, '#!/bin/sh\nprintf "%s" "$DAHRK_GIT_TOKEN"\n', { mode: 0o700 });
    return {
      env: { ...process.env, GIT_ASKPASS: script, DAHRK_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  };

  /**
   * Env for a network git op (clone/fetch/push/remote update). Always disables git's interactive
   * credential prompt so a host that cannot authenticate fails fast with git's real auth error
   * instead of falling through to a Username prompt that, under pm2/tsx (no TTY), dies with the
   * confusing `could not read Username ... Device not configured`. When a brokered token is present
   * its askpass env already carries `GIT_TERMINAL_PROMPT=0`; the tokenless (ambient) path gets it
   * here, so ambient auth failures are as clear as brokered ones.
   */
  const netEnv = (authEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
    authEnv ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  /** Add an `x-access-token` username to an HTTPS URL so the askpass password (the token) is used.
   *  Only the (non-secret) username is embedded - the token never lands in the URL or git config. */
  const withTokenUser = (gitUrl: string): string =>
    /^https:\/\/[^@/]+@/.test(gitUrl) ? gitUrl : gitUrl.replace(/^https:\/\//, "https://x-access-token@");

  /**
   * Resolve the remote URL and credentials for a network op against the REAL remote (the deliver,
   * backup, and reconcile push paths). A brokered token gets a transient `GIT_ASKPASS` helper (torn
   * down by `cleanup`) plus an `x-access-token@` remote so the askpass password is used; an ambient
   * node gets the plain URL and relies on host credentials (git config helper, `gh`, SSH). `authEnv`
   * is the raw askpass env, undefined when ambient - callers wrap it in {@link netEnv} for the network
   * ops and pass it as-is to the local merge. Consolidates the credential setup those paths repeat.
   */
  const resolveRemoteAuth = (
    gitUrl: string,
    credentialToken?: string,
  ): { remote: string; authEnv?: NodeJS.ProcessEnv; cleanup: () => void } => {
    const auth = credentialToken ? setupAuth(credentialToken) : undefined;
    return {
      remote: credentialToken ? withTokenUser(gitUrl) : gitUrl,
      authEnv: auth?.env,
      cleanup: () => auth?.cleanup(),
    };
  };

  /** The per-repo bare mirror path, keyed by repoId (sanitised so a slashy id is one dir). */
  const mirrorPathFor = (repoId: string): string => join(mirrorsDir, sanitizeBranchName(repoId));

  /**
   * The worktrees a mirror has registered, from `git worktree list --porcelain`. `branch` is the short
   * name the worktree's admin HEAD symrefs, which git reports even when the ref itself no longer exists
   * (the dangling-claim case that blocks `worktree add`), so this is what a collision check must consult.
   */
  const listWorktrees = (mirror: string): Array<{ path: string; branch: string }> => {
    let out: string;
    try {
      out = git(mirror, ["worktree", "list", "--porcelain"]);
    } catch {
      return [];
    }
    const entries: Array<{ path: string; branch: string }> = [];
    let path = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9).trim();
      else if (line.startsWith("branch ")) {
        const branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
        if (path) entries.push({ path, branch });
      } else if (line.trim() === "") path = "";
    }
    return entries;
  };

  /**
   * Remove one worktree by path and prune the mirror's admin entry. Shared by `teardownWorktree` and
   * the stale-claim clearing in `createWorktree`, so both drop the *registration* (not just the dir):
   * a leftover admin entry keeps claiming its branch name for ever, which is what wedged every re-run
   * of an issue (DHK-371). Safe when the directory is already gone.
   */
  const teardownWorktreePath = (mirror: string, worktreePath: string): void => {
    try {
      git(mirror, ["worktree", "remove", "--force", worktreePath]);
    } catch (e) {
      log.warn(`git worktree remove failed for ${worktreePath}: ${(e as Error).message}`);
    }
    rmSync(worktreePath, { recursive: true, force: true });
    gitOk(mirror, ["worktree", "prune"]);
  };

  /** The tracking refspec every mirror must use. See `migrateMirrorConfig` for why. */
  const TRACKING_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

  /**
   * Bring a mirror onto the tracking-refspec layout, idempotently (DHK-371).
   *
   * A `--mirror` clone sets `remote.origin.mirror=true` and the refspec `+refs/*:refs/*`, which makes
   * every fetch force-sync LOCAL refs to match the remote exactly. Our run branches live in
   * `refs/heads/*` and are deliberately absent from the remote until deliver pushes them (and GitHub
   * deletes the head branch on merge, so they leave again). A `--mirror` fetch therefore DELETES the
   * branch of any run in flight, orphaning its commits and leaving the worktree on an unborn HEAD.
   *
   * The fix is a namespace split: `refs/remotes/origin/*` is theirs (fetched and pruned), `refs/heads/*`
   * is ours (run branches, never touched by a fetch). This migrates an existing legacy mirror in place
   * on the next refresh: no re-clone, no operator step, and safe to run against an already-migrated one.
   */
  const migrateMirrorConfig = (mirror: string, repoId: string): void => {
    const isMirror = gitOk(mirror, ["config", "--get", "remote.origin.mirror"]);
    const refspecs = (() => {
      try {
        return git(mirror, ["config", "--get-all", "remote.origin.fetch"]).split("\n").map((s) => s.trim());
      } catch {
        return [];
      }
    })();
    if (!isMirror && refspecs.length === 1 && refspecs[0] === TRACKING_REFSPEC) return; // already migrated

    log.info(`mirror ${repoId}: migrating to the tracking-refspec layout (was mirror=${isMirror})`);
    // `mirror=true` also makes any `git push origin` from here a MIRROR push, which would delete remote
    // branches absent locally. Nothing pushes from the mirror today, but that is not a footgun to leave
    // armed next to a `worktree add --force`. Unset it and any push refspec along with it.
    for (const args of [
      ["config", "--unset-all", "remote.origin.mirror"],
      ["config", "--unset-all", "remote.origin.push"],
    ]) {
      gitOk(mirror, args); // exit 5 = "nothing to unset", which is success here
    }
    git(mirror, ["config", "--replace-all", "remote.origin.fetch", TRACKING_REFSPEC]);
  };

  /**
   * Park the tip of a local branch we are about to `-B` (create-or-reset) away, but only when that tip
   * holds commits the new start point does not already contain. This is the insurance on `-B`: an
   * unpushed run branch can never be silently destroyed by the next run of the same issue. The parked
   * ref lives outside `refs/heads/*` so it claims no branch name and no worktree, and is expired by the
   * reaper. Best-effort throughout: salvage must never be the reason a run fails to start.
   */
  const salvageOrphanedTip = (mirror: string, branchName: string, start: string): void => {
    try {
      if (!gitOk(mirror, ["rev-parse", "--verify", "-q", `refs/heads/${branchName}`])) return;
      // `merge-base --is-ancestor <tip> <start>` succeeds iff start already contains tip => nothing unique.
      if (gitOk(mirror, ["merge-base", "--is-ancestor", `refs/heads/${branchName}`, start])) return;
      const sha = git(mirror, ["rev-parse", `refs/heads/${branchName}`]).trim();
      const ref = `refs/dahrk/salvage/${branchName}/${sha.slice(0, 12)}`;
      git(mirror, ["update-ref", ref, sha]);
      log.warn(`parked orphaned tip of ${branchName} (${sha.slice(0, 8)}) at ${ref} before reset`);
    } catch (e) {
      log.warn(`could not salvage tip of ${branchName}: ${(e as Error).message}`);
    }
  };

  /**
   * Garbage-collect the "shadow" local heads a legacy `--mirror` layout left in `refs/heads/*` (the
   * remote's branches copied straight in, e.g. a now-frozen `main`). After migration those are stale
   * duplicates of `refs/remotes/origin/*` and would shadow the real base.
   *
   * A shadow head is defined narrowly: a local head that MIRRORS A REMOTE BRANCH OF THE SAME NAME. It is
   * tempting to instead delete any head already contained in some origin ref, but that is wrong and
   * dangerous: a run branch that has been created but has not committed yet sits exactly at the base tip,
   * so it is "contained" in `origin/main` and would be deleted out from under its live worktree - which
   * is the very data loss this whole change exists to stop. An unpushed run branch has no same-named
   * origin counterpart, so this rule always keeps it.
   */
  const gcShadowHeads = (mirror: string): void => {
    let heads: string[];
    try {
      heads = git(mirror, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return;
    }
    const held = new Set(listWorktrees(mirror).map((w) => w.branch));
    const ownHead = (() => {
      try {
        return git(mirror, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
      } catch {
        return "";
      }
    })();
    for (const h of heads) {
      if (h === ownHead || held.has(h)) continue;
      // Only a head that duplicates a same-named remote branch is a shadow. Anything else is ours.
      if (!gitOk(mirror, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${h}`])) continue;
      // And only when the remote copy is not BEHIND us, so a local head carrying commits the remote has
      // not seen (a delivered branch we pushed but whose push has not landed) is never dropped.
      if (!gitOk(mirror, ["merge-base", "--is-ancestor", `refs/heads/${h}`, `refs/remotes/origin/${h}`])) continue;
      gitOk(mirror, ["branch", "-D", h]);
    }
  };

  /**
   * Ensure a bare mirror of the repo exists and is current. On first sight: `init --bare` + a tracking
   * refspec + `fetch --prune`. Deliberately NOT `clone --mirror` (which arms the ref-destroying layout
   * described in `migrateMirrorConfig`) and NOT `clone --bare` (which copies remote heads straight into
   * `refs/heads/*`, reintroducing the same shadow-head footgun). Starting from an empty `refs/heads/*`
   * means every local head is, by construction, ours.
   *
   * Returns the mirror path plus whether the refresh actually landed: a swallowed refresh failure means
   * the cached base may be stale, which the caller must reconcile before branching a new run off it.
   */
  const ensureMirror = (
    repoId: string,
    gitUrl: string,
    authEnv?: NodeJS.ProcessEnv,
  ): { mirror: string; refreshed: boolean } => {
    const mirror = mirrorPathFor(repoId);
    if (existsSync(mirror) && gitOk(mirror, ["rev-parse", "--git-dir"])) {
      log.info(`refreshing mirror ${repoId}`);
      try {
        migrateMirrorConfig(mirror, repoId);
        git(mirror, ["fetch", "--prune", "origin"], netEnv(authEnv));
        gcShadowHeads(mirror);
        return { mirror, refreshed: true };
      } catch (e) {
        // A refresh failure (offline, transient) does not abort here: the cached mirror still serves
        // continuation (an existing per-issue branch is already folded in). But the base may now be
        // stale, so we flag it; branching a NEW run off the base re-checks freshness.
        log.warn(`mirror fetch failed for ${repoId}: ${(e as Error).message}`);
        return { mirror, refreshed: false };
      }
    }
    mkdirSync(mirror, { recursive: true });
    const cloneUrl = authEnv ? withTokenUser(gitUrl) : gitUrl;
    log.info(`cloning mirror ${repoId} from ${gitUrl}`);
    gitBare(["init", "--bare", "--quiet", mirror]);
    git(mirror, ["remote", "add", "origin", cloneUrl]);
    git(mirror, ["config", "--replace-all", "remote.origin.fetch", TRACKING_REFSPEC]);
    git(mirror, ["fetch", "--prune", "origin"], netEnv(authEnv));
    return { mirror, refreshed: true };
  };

  // `branch` is carried on the ref even though nothing here needs it, because everything DOWNSTREAM
  // does and had no way to get it: the ref is the only handle the stage runner and the ws client hold
  // on a live run, so a ref without a branch left the node unable to say which branch it was working on
  // (DHK-416's job ledger, and the checkpoint the hub wants on its dispatch row, both want it). Same
  // sanitisation as `createWorktree` uses to make the branch, so the two can never disagree.
  const refFor = (spec: WorktreeSpec, worktreePath: string): WorkspaceRef => ({
    repoId: spec.repoId,
    gitUrl: spec.gitUrl,
    repo: spec.repo ?? spec.repoId,
    baseBranch: spec.baseBranch,
    branch: sanitizeBranchName(spec.branch ?? `dahrk/${spec.runId}`),
    worktreePath,
    scratchPath: join(worktreePath, ".skakel", "scratch"),
  });

  return {
    worktreesDir,
    async createWorktree(spec) {
      const { repoId, gitUrl, baseBranch, runId } = spec;
      const branchName = sanitizeBranchName(spec.branch ?? `dahrk/${runId}`);
      const worktreePath = join(worktreesDir, runId);
      mkdirSync(worktreesDir, { recursive: true });

      // Reuse an existing, still-valid worktree for this run (re-dispatch / sticky owner). No clone
      // needed: the worktree already exists from an earlier stage of the same run.
      if (existsSync(worktreePath) && gitOk(worktreePath, ["rev-parse", "--git-dir"])) {
        log.info(`reusing existing worktree at ${worktreePath}`);
        mkdirSync(join(worktreePath, ".skakel", "scratch"), { recursive: true });
        return refFor(spec, worktreePath);
      }

      // Brokered token (if any) authorises the clone/fetch only; it stays set up through the worktree
      // build (a possible base-branch fetch below needs it) and is torn down in the finally - the
      // local `worktree add` itself needs no credential.
      const auth = spec.credentialToken ? setupAuth(spec.credentialToken) : undefined;
      try {
        const { mirror, refreshed } = ensureMirror(repoId, gitUrl, auth?.env);

        // Clear any stale claim on this branch BEFORE adding. A worktree that was never torn down keeps
        // claiming its branch for ever - even after the ref itself is gone - and git's `die_if_checked_out`
        // then refuses the add ("'<branch>' is already used by worktree at ..."). That wedged every re-run
        // of an issue (DHK-371). Prune first (drops entries whose dir has vanished), then evict whatever
        // still holds the name. A holder belonging to a run that is genuinely in flight is NOT evicted:
        // two live runs on one issue is a routing bug, and a truthful error beats stomping a live worktree.
        gitOk(mirror, ["worktree", "prune"]);
        for (const w of listWorktrees(mirror)) {
          if (w.branch !== branchName || w.path === worktreePath) continue;
          const holder = basename(w.path);
          if (isBusy?.(holder)) {
            throw new Error(`branch ${branchName} is held by in-flight run ${holder} (${w.path})`);
          }
          log.warn(`clearing stale worktree ${w.path} which still claims ${branchName}`);
          teardownWorktreePath(mirror, w.path);
        }

        // Pick the start point deterministically. A leftover LOCAL `refs/heads/<branch>` is never a start
        // point: it may be a corpse from a killed run, or a ref the previously-failing `add -b` re-created
        // moments before it aborted, and branching off it silently bases the run on a stale commit instead
        // of the base. Continuation is expressed by the REMOTE branch (a prior session that delivered),
        // which is exactly what `WorkspaceRef.branch` documents.
        const remoteBranch = `refs/remotes/origin/${branchName}`;
        const remoteBase = `refs/remotes/origin/${baseBranch}`;
        if (!refreshed) {
          // A NEW run branches from the base, which MUST be current. Branching off a stale cached base
          // silently produces work against an old tree: a run once re-implemented an already-merged fix
          // because its mirror lagged the remote. If the refresh did not land, fetch the base
          // authoritatively now; if that also fails we throw rather than branch from a base we cannot
          // confirm is fresh (truthful failure over a phantom-stale run).
          log.info(`mirror refresh failed; fetching base ${baseBranch} before branching ${branchName}`);
          git(mirror, ["fetch", "origin", `+refs/heads/${baseBranch}:${remoteBase}`], netEnv(auth?.env));
        }
        const seed = spec.seedRef && gitOk(mirror, ["rev-parse", "--verify", "-q", spec.seedRef])
          ? spec.seedRef
          : undefined;
        const start = seed ?? (gitOk(mirror, ["rev-parse", "--verify", "-q", remoteBranch]) ? remoteBranch : remoteBase);
        if (!gitOk(mirror, ["rev-parse", "--verify", "-q", start])) {
          throw new Error(`start point '${start}' does not resolve in mirror ${repoId}`);
        }

        // Park any local tip we are about to discard, so `-B` can never silently destroy work. Only when
        // the existing head is NOT already contained in the start point (i.e. it holds unique commits).
        salvageOrphanedTip(mirror, branchName, start);

        // `-B` is create-or-reset and is transactional with the checkout, so a branch ref left behind by a
        // previously failed `add -b` is harmless. `--force` is the belt, not the mechanism: the stale
        // claims were already cleared above, and this only covers a race.
        log.info(`creating worktree at ${worktreePath} from ${start} on ${branchName}`);
        git(mirror, ["worktree", "add", "--force", "-B", branchName, worktreePath, start]);
      } finally {
        auth?.cleanup();
      }

      // Fail fast on an unborn worktree. If the base did not materialise (empty/unresolvable ref), the
      // worktree checks out with no commit and HEAD does not resolve - every later `git ... HEAD` throws
      // `ambiguous argument 'HEAD'`, and the run limps to deliver where the first commit lands on a
      // history unrelated to the base. Refuse to hand back a broken worktree; a truthful intake error
      // beats a run that fails opaquely three stages later.
      if (!gitOk(worktreePath, ["rev-parse", "--verify", "-q", "HEAD"])) {
        throw new Error(`base '${baseBranch}' did not materialise into ${worktreePath} (unborn HEAD)`);
      }

      mkdirSync(join(worktreePath, ".skakel", "scratch"), { recursive: true });
      return refFor(spec, worktreePath);
    },

    async commitAndPush(ref, opts) {
      const { worktreePath } = ref;
      if (!existsSync(worktreePath) || !gitOk(worktreePath, ["rev-parse", "--git-dir"])) {
        throw new Error(`worktree missing for push: ${worktreePath}`);
      }
      const branch = sanitizeBranchName(opts.branch);
      // The engine-owned scratch dir (state.json, traces, issue.md) lives in the worktree so stages
      // can read/write it, but it is RUNTIME state and must never enter the PR. `commitPending` untracks
      // it (so continuation drops it), stages everything else, and commits only if the worktree is dirty.
      const { headSha: committedSha, dirty } = commitPending(worktreePath, opts.message);
      let headSha = committedSha;
      // How far the branch is ahead of its base, for a human-readable "N commits" in Linear. Freshest
      // form first: `FETCH_HEAD` is the base we just fetched above, then the remote-tracking ref. A bare
      // name (`main`) is LAST because it resolves to a local head, which under the old `--mirror` layout
      // happened to track the remote but is now ours and could be stale or absent (DHK-371). Best-effort,
      // so a failure (base not present under any name) yields 0 rather than aborting the push.
      let commitsAhead = 0;
      for (const baseRef of ["FETCH_HEAD", `origin/${opts.base}`, opts.base, `refs/heads/${opts.base}`]) {
        if (!baseRef) continue;
        try {
          commitsAhead = Number.parseInt(git(worktreePath, ["rev-list", "--count", `${baseRef}..HEAD`]).trim(), 10) || 0;
          break;
        } catch {
          /* base not present under this name; try the next form */
        }
      }

      // Push to the REAL remote, never `origin` (which for a mirror-backed worktree may be the local
      // mirror). `HEAD:refs/heads/<branch>` targets the stable per-issue branch regardless of the
      // local branch name. The brokered token (when given) authorises BOTH the base fetch below and the
      // push, so its askpass helper is set up once here and torn down in the finally; else ambient host
      // credentials are used.
      const { remote, authEnv, cleanup } = resolveRemoteAuth(ref.gitUrl, opts.credentialToken);
      let pushed = false;
      let integration: "clean" | "conflict" | undefined;
      try {
        // refresh the base ref at PUSH time (not just at intake) and merge it into the branch
        // BEFORE pushing, so parallel runs that all branched off the same commit integrate each other's
        // landed work here instead of colliding only when they reach the base. Fetch the REAL remote's
        // base tip into FETCH_HEAD (the worktree's `origin` is the possibly-stale local mirror), then
        // `git merge --no-edit` (merge, not rebase: continuation runs may already be pushed, so avoid a
        // force-push). This is a deterministic git side effect; no LLM decides anything (the engine has
        // already chosen to run open-pr). The conflict outcome is reported up so the hub raises a
        // manual-merge elicitation rather than opening a PR.
        let fetched = false;
        if (opts.base) {
          try {
            git(worktreePath, ["fetch", remote, opts.base], netEnv(authEnv));
            fetched = true;
          } catch (e) {
            // Best-effort: an offline/transient fetch failure must not fabricate a conflict. Skip
            // integration and push as before (the pre behaviour), no worse than a stale base.
            log.warn(`base fetch failed for ${opts.base}; skipping push-time integration: ${(e as Error).message}`);
          }
        }
        if (fetched) {
          // Diverged histories cannot integrate: if the branch and the fetched base share no common
          // ancestor, a `git merge` would fail to start (`refusing to merge unrelated histories`).
          // Detect it up front so the outcome is an explicit `diverged` rather than depending on the
          // catch below to classify the git error. This is the belt to the catch's braces.
          if (!gitOk(worktreePath, ["merge-base", "HEAD", "FETCH_HEAD"])) {
            return { headSha, pushed: false, nothingToCommit: !dirty, commitsAhead, integration: "diverged" };
          }
          // Nothing to deliver (DHK-318): the branch's own contribution over the freshly fetched base
          // (`FETCH_HEAD...HEAD`, the diff since their merge base) is empty or consists solely of the
          // engine-owned scratch dir or otherwise git-ignored paths. Short-circuit to an explicit `noop`
          // BEFORE merging/pushing, so a run whose work is already on the base - or whose only delta is a
          // stray scratch file some prompt regression committed - closes as a clean "already delivered"
          // outcome instead of risking a base-advanced merge conflict on that scratch path. Independent
          // of the harness-side gitignore fix: even a committed scratch path cannot become a push error.
          const delta = git(worktreePath, ["diff", "--name-only", "FETCH_HEAD...HEAD"])
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          // `--no-index` so a path is judged purely by the ignore rules, not by whether it is tracked:
          // a scratch file a regression already committed is still recognised as ignored (plain
          // `check-ignore` never reports a tracked path).
          const isScratchPath = (p: string): boolean =>
            p === SCRATCH_DIR ||
            p.startsWith(`${SCRATCH_DIR}/`) ||
            gitOk(worktreePath, ["check-ignore", "-q", "--no-index", "--", p]);
          if (!delta.some((p) => !isScratchPath(p))) {
            return { headSha, pushed: false, nothingToCommit: true, commitsAhead, integration: "noop" };
          }
          try {
            // A non-fast-forward merge writes a commit, so pass the same committer identity as the commit.
            git(worktreePath, [
              "-c",
              `user.name=${authorName}`,
              "-c",
              `user.email=${authorEmail}`,
              "merge",
              "--no-edit",
              "FETCH_HEAD",
            ], authEnv);
            integration = "clean";
            headSha = git(worktreePath, ["rev-parse", "HEAD"]).trim();
          } catch (mergeErr) {
            // A merge can fail two very different ways, and they need different recovery:
            //  (1) it STARTED and hit content conflicts - MERGE_HEAD exists and there are unmerged
            //      paths. Capture them, `merge --abort` (leaves the worktree clean), push nothing; the
            //      hub turns `integration: "conflict"` into a manual-merge elicitation.
            //  (2) it FAILED TO START - no MERGE_HEAD (e.g. `refusing to merge unrelated histories`, an
            //      unborn HEAD). Here `git merge --abort` would itself throw ("no merge to abort") and
            //      MASK the real error as an opaque `push failed: Command failed: git merge --abort`.
            //      So we must NOT abort a merge that never began; distinguish the two by MERGE_HEAD.
            const inMerge = gitOk(worktreePath, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
            if (inMerge) {
              const conflictFiles = git(worktreePath, ["diff", "--name-only", "--diff-filter=U"])
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
              git(worktreePath, ["merge", "--abort"]);
              return { headSha, pushed: false, nothingToCommit: !dirty, commitsAhead, integration: "conflict", conflictFiles };
            }
            // Unrelated/diverged histories: no shared ancestor, so the base can never auto-integrate.
            // Report it as its own outcome (nothing pushed) rather than a content conflict - a
            // `--allow-unrelated-histories` merge would only splice a garbage tree, so an agent cannot
            // resolve it; the branch needs rebuilding from base.
            const msg = (mergeErr as Error).message;
            if (/unrelated histories|refusing to merge/i.test(msg)) {
              return { headSha, pushed: false, nothingToCommit: !dirty, commitsAhead, integration: "diverged" };
            }
            // Any other merge-start failure: surface the REAL git error truthfully instead of masking it.
            throw mergeErr;
          }
        }
        git(worktreePath, ["push", remote, `HEAD:refs/heads/${branch}`], netEnv(authEnv));
        pushed = true;
      } finally {
        cleanup();
      }
      return { headSha, pushed, nothingToCommit: !dirty, commitsAhead, ...(integration ? { integration } : {}) };
    },

    async backupPush(ref, opts) {
      const { worktreePath } = ref;
      if (!existsSync(worktreePath) || !gitOk(worktreePath, ["rev-parse", "--git-dir"])) {
        throw new Error(`worktree missing for backup push: ${worktreePath}`);
      }
      const wipRef = sanitizeBranchName(opts.branch);
      // Commit any pending work so the WIP ref captures the FULL run state, not just the last commit.
      const { headSha, dirty } = commitPending(worktreePath, opts.message);
      // Force-push HEAD directly to the disposable WIP ref on the REAL remote (never `origin`, which for
      // a mirror-backed worktree may be the local mirror). Deliberately NO base fetch/merge and NO PR:
      // the ref only has to preserve this run's committed HEAD before the worktree is reaped, so the
      // integration that `commitAndPush` does (which would abort on the very conflict that triggered this
      // backup) is skipped. The ref is disposable, so `--force` overwrites any prior WIP tip. The brokered
      // token (when given) authorises the push via its askpass helper; else ambient host credentials.
      const { remote, authEnv, cleanup } = resolveRemoteAuth(ref.gitUrl, opts.credentialToken);
      try {
        git(worktreePath, ["push", "--force", remote, `HEAD:refs/heads/${wipRef}`], netEnv(authEnv));
      } finally {
        cleanup();
      }
      return { headSha, pushed: true, nothingToCommit: !dirty, wipRef };
    },

    async reconcileInterrupted(ref, opts) {
      const { worktreePath } = ref;
      if (!existsSync(worktreePath) || !gitOk(worktreePath, ["rev-parse", "--git-dir"])) {
        throw new Error(`worktree missing for reconcile: ${worktreePath}`);
      }
      // The commit the agent last completed. This is what we reset back to, so read it BEFORE
      // `commitPending` moves HEAD onto the tail.
      const headSha = git(worktreePath, ["rev-parse", "HEAD"]).trim();
      const wipRef = sanitizeBranchName(opts.branch);

      // Commit whatever the killed agent left behind. Nothing staged means the tree was clean when the
      // process died (the agent was thinking, not writing): there is no tail, no reset, nothing to do.
      const { headSha: tailSha, dirty } = commitPending(worktreePath, opts.message);
      if (!dirty) return { dirty: false, headSha, pushed: false };

      // Pin the tail LOCALLY before anything can fail. After the reset below, this ref is the only thing
      // keeping the tail commit reachable, and it must exist whether or not the network does - boot
      // reconciliation runs before the socket is up, and an operator who has lost power should still be
      // able to find what the agent had written.
      git(worktreePath, ["branch", "--force", wipRef, tailSha]);

      // Now try to get it off the box too. Best-effort by design: a node that cannot reach the remote
      // still has to end this function with a clean tree, and the tail is already safe on the local ref.
      let pushed = false;
      const { remote, authEnv, cleanup } = resolveRemoteAuth(ref.gitUrl, opts.credentialToken);
      try {
        git(worktreePath, ["push", "--force", remote, `${tailSha}:refs/heads/${wipRef}`], netEnv(authEnv));
        pushed = true;
      } catch (e) {
        log.warn(`could not push the preserved tail to ${wipRef}: ${(e as Error).message}`);
      } finally {
        cleanup();
      }

      // Back to the last good commit, and drop the untracked debris the agent left with it. Without the
      // `-x`/`clean` the tree would still carry untracked half-written files, which is the corruption we
      // are here to prevent; scratch is excluded because it is engine-owned state, not agent output.
      git(worktreePath, ["reset", "--hard", headSha]);
      git(worktreePath, ["clean", "-fd", "--exclude", SCRATCH_DIR]);

      return { dirty: true, headSha, tailSha, wipRef, pushed };
    },

    async openPrAmbient(ref, opts) {
      const ownerRepo = parseOwnerRepo(ref.gitUrl);
      if (!ownerRepo) return { prError: `cannot derive owner/repo from ${ref.gitUrl}` };
      const { worktreePath } = ref;
      const branch = sanitizeBranchName(opts.branch);
      // Always target the GitHub repo explicitly (`--repo`): a mirror-backed worktree's `origin` may
      // be the local mirror, not GitHub, so letting gh infer the repo from the remote is unreliable.
      const repoArgs = ["--repo", ownerRepo];
      // Read back the PR for this head, so we return a number+url whether we just opened it or it
      // already existed (idempotent, mirroring the push). Best-effort: a failure yields undefined.
      const readBack = (): OpenPrResult | undefined => {
        try {
          const pr = JSON.parse(gh(worktreePath, ["pr", "view", branch, ...repoArgs, "--json", "number,url"])) as {
            number?: number;
            url?: string;
          };
          return pr.url
            ? { prUrl: pr.url, ...(pr.number !== undefined ? { prNumber: pr.number } : {}) }
            : undefined;
        } catch {
          return undefined;
        }
      };
      // The body may be arbitrarily long / contain markdown; pass it via a temp file, never argv.
      const tmp = mkdtempSync(join(tmpdir(), "dahrk-pr-"));
      const bodyFile = join(tmp, "body.md");
      try {
        writeFileSync(bodyFile, opts.body ?? "");
        try {
          gh(worktreePath, [
            "pr",
            "create",
            ...repoArgs,
            "--head",
            branch,
            "--base",
            opts.base,
            "--title",
            opts.title,
            "--body-file",
            bodyFile,
          ]);
        } catch (e) {
          // An existing PR for this head is success (re-summons re-run open-pr). Any other failure
          // (gh missing/unauthed, API error) is non-fatal: surface a reason, keep the pushed branch.
          const existing = readBack();
          if (existing) return existing;
          return { prError: ghError(e) };
        }
        return readBack() ?? { prError: "gh pr create reported success but no PR was found" };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },

    async teardownWorktree(ref) {
      // No `existsSync` guard: a directory deleted by hand still leaves the mirror's admin entry, which
      // goes on claiming its branch name for ever. The prune inside `teardownWorktreePath` is exactly
      // what clears that, so this must run even when the dir is already gone (DHK-371).
      teardownWorktreePath(mirrorPathFor(ref.repoId), ref.worktreePath);
    },
  };
}
