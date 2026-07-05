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
import { dirname, isAbsolute, join } from "node:path";
import type { WorkspaceRef } from "@dahrk/contracts";

/** Minimal logger; defaults to a no-op so the library is quiet in tests. */
export interface GitLogger {
  info(msg: string): void;
  warn(msg: string): void;
}
const noopLogger: GitLogger = { info: () => {}, warn: () => {} };

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
  /** Outcome of merging the freshly fetched base into the branch before pushing. `conflict`
   *  means the merge was aborted and nothing was pushed; absent when integration was skipped (no base
   *  given, or the base fetch failed) so the legacy push-only path is treated as clean. */
  integration?: "clean" | "conflict";
  /** The conflicted paths when `integration === "conflict"` (`git diff --name-only --diff-filter=U`). */
  conflictFiles?: string[];
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
   * Ambient-node PR fallback: after a successful push, best-effort open (or reuse) the PR via the
   * host's `gh` CLI, using the host's ambient `gh` auth (or `GH_TOKEN`/`GITHUB_TOKEN`). Symmetric with
   * the ambient SSH push. Never throws: any failure (gh missing/unauthed, API error) is returned as
   * `prError`, leaving the already-pushed branch as the deliverable. Brokered nodes do not use this;
   * the hub opens their PR through the credential broker.
   */
  openPrAmbient(ref: WorkspaceRef, opts: OpenPrOpts): Promise<OpenPrResult>;
  teardownWorktree(ref: WorkspaceRef): Promise<void>;
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

export function createGitService(opts: GitServiceOptions = {}): GitService {
  const worktreesDir =
    opts.worktreesDir ?? process.env.DAHRK_WORKTREES_DIR ?? process.env.SKAKEL_WORKTREES_DIR ?? join(homedir(), ".dahrk", "worktrees");
  const mirrorsDir =
    opts.mirrorsDir ?? process.env.DAHRK_MIRRORS_DIR ?? process.env.SKAKEL_MIRRORS_DIR ?? join(homedir(), ".dahrk", "mirrors");
  const authorName = opts.authorName ?? process.env.DAHRK_GIT_AUTHOR_NAME ?? "Dahrk";
  const authorEmail = opts.authorEmail ?? process.env.DAHRK_GIT_AUTHOR_EMAIL ?? "noreply@dahrk.ai";
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
    const entry = ".skakel/scratch/";
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

  /** The per-repo bare mirror path, keyed by repoId (sanitised so a slashy id is one dir). */
  const mirrorPathFor = (repoId: string): string => join(mirrorsDir, sanitizeBranchName(repoId));

  /**
   * Ensure a bare mirror of the repo exists and is current: `clone --mirror` on first sight,
   * `remote update --prune` after. The mirror's `refs/heads/*` track the remote, so the base branch
   * resolves as a local ref for `worktree add`. Returns the mirror path plus whether the refresh
   * actually landed: a fresh clone is current by construction, an existing mirror only if the
   * `remote update` succeeded. A swallowed refresh failure means the cached base may be stale, which
   * the caller must reconcile before branching a new run off it.
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
        git(mirror, ["remote", "update", "--prune"], netEnv(authEnv));
        return { mirror, refreshed: true };
      } catch (e) {
        // A refresh failure (offline, transient) does not abort here: the cached mirror still serves
        // continuation (an existing per-issue branch is already folded in). But the base may now be
        // stale, so we flag it; branching a NEW run off the base re-checks freshness.
        log.warn(`mirror remote update failed for ${repoId}: ${(e as Error).message}`);
        return { mirror, refreshed: false };
      }
    }
    mkdirSync(mirrorsDir, { recursive: true });
    const cloneUrl = authEnv ? withTokenUser(gitUrl) : gitUrl;
    log.info(`cloning mirror ${repoId} from ${gitUrl}`);
    gitBare(["clone", "--mirror", cloneUrl, mirror], netEnv(authEnv));
    return { mirror, refreshed: true };
  };

  const refFor = (spec: WorktreeSpec, worktreePath: string): WorkspaceRef => ({
    repoId: spec.repoId,
    gitUrl: spec.gitUrl,
    repo: spec.repo ?? spec.repoId,
    baseBranch: spec.baseBranch,
    worktreePath,
    scratchPath: join(worktreePath, ".skakel", "scratch"),
  });

  return {
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

        // Add the per-run worktree off the mirror. Check out the branch if it already exists - either a
        // re-clone of this run's branch, or the stable per-issue branch from a prior session (the mirror
        // refresh above folded the remote branch in), so a re-summon continues from its commits.
        // `--force` lets a new session's worktree check out a branch a not-yet-torn-down prior worktree
        // still holds (sessions on one issue are sequential; see plan risk 6). Otherwise branch from base.
        if (gitOk(mirror, ["rev-parse", "--verify", branchName])) {
          git(mirror, ["worktree", "add", "--force", worktreePath, branchName]);
        } else {
          // A NEW run branches from the base, which MUST be current. Branching off a stale cached base
          // silently produces work against an old tree a run re-implemented an already-merged
          // fix because its mirror's `main` lagged the remote by six commits. If the refresh above did
          // not land, fetch the base authoritatively now; if that also fails we throw rather than branch
          // from a base we cannot confirm is fresh (truthful failure over a phantom-stale run).
          if (!refreshed) {
            log.info(`mirror refresh failed; fetching base ${baseBranch} before branching ${branchName}`);
            git(mirror, ["fetch", "origin", `+refs/heads/${baseBranch}:refs/heads/${baseBranch}`], netEnv(auth?.env));
          }
          log.info(`creating worktree at ${worktreePath} from ${baseBranch} on ${branchName}`);
          git(mirror, ["worktree", "add", "-b", branchName, worktreePath, baseBranch]);
        }
      } finally {
        auth?.cleanup();
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
      // can read/write it, but it is RUNTIME state and must never enter the PR. Untrack it if a prior
      // commit captured it (so continuation drops it), then stage everything else. Excluding it here -
      // not relying on each target repo's .gitignore - protects every repo the harness runs against.
      const SCRATCH = ".skakel/scratch";
      excludeScratchLocally(worktreePath);
      git(worktreePath, ["rm", "-r", "--cached", "--ignore-unmatch", "--quiet", SCRATCH]);
      git(worktreePath, ["add", "-A", "--", "."]);
      // Commit only when something is actually staged (`diff --cached --quiet` exits non-zero iff so).
      const hasStaged = !gitOk(worktreePath, ["diff", "--cached", "--quiet"]);
      if (hasStaged) {
        git(worktreePath, [
          "-c",
          `user.name=${authorName}`,
          "-c",
          `user.email=${authorEmail}`,
          "commit",
          "-m",
          opts.message,
        ]);
      }
      const dirty = hasStaged;
      let headSha = git(worktreePath, ["rev-parse", "HEAD"]).trim();
      // How far the branch is ahead of its base, for a human-readable "N commits" in Linear. The base
      // may be a bare name (e.g. `main`) resolved via the mirror's tracking ref; best-effort, so a
      // failure (base not present locally) yields 0 rather than aborting the push.
      let commitsAhead = 0;
      for (const baseRef of [opts.base, `origin/${opts.base}`, `refs/heads/${opts.base}`]) {
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
      const auth = opts.credentialToken ? setupAuth(opts.credentialToken) : undefined;
      const remote = opts.credentialToken ? withTokenUser(ref.gitUrl) : ref.gitUrl;
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
            git(worktreePath, ["fetch", remote, opts.base], netEnv(auth?.env));
            fetched = true;
          } catch (e) {
            // Best-effort: an offline/transient fetch failure must not fabricate a conflict. Skip
            // integration and push as before (the pre behaviour), no worse than a stale base.
            log.warn(`base fetch failed for ${opts.base}; skipping push-time integration: ${(e as Error).message}`);
          }
        }
        if (fetched) {
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
            ], auth?.env);
            integration = "clean";
            headSha = git(worktreePath, ["rev-parse", "HEAD"]).trim();
          } catch {
            // Conflict: capture the conflicted paths, abort the merge (leaving the worktree clean), and
            // do NOT push. The hub turns `integration: "conflict"` into a manual-merge elicitation.
            const conflictFiles = git(worktreePath, ["diff", "--name-only", "--diff-filter=U"])
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            git(worktreePath, ["merge", "--abort"]);
            return { headSha, pushed: false, nothingToCommit: !dirty, commitsAhead, integration: "conflict", conflictFiles };
          }
        }
        git(worktreePath, ["push", remote, `HEAD:refs/heads/${branch}`], netEnv(auth?.env));
        pushed = true;
      } finally {
        auth?.cleanup();
      }
      return { headSha, pushed, nothingToCommit: !dirty, commitsAhead, ...(integration ? { integration } : {}) };
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
      if (!existsSync(ref.worktreePath)) return;
      // Worktree bookkeeping lives in the mirror; run the remove/prune there.
      const mirror = mirrorPathFor(ref.repoId);
      try {
        git(mirror, ["worktree", "remove", "--force", ref.worktreePath]);
      } catch (e) {
        log.warn(`git worktree remove failed for ${ref.worktreePath}: ${(e as Error).message}`);
      }
      rmSync(ref.worktreePath, { recursive: true, force: true });
      try {
        git(mirror, ["worktree", "prune"]);
      } catch {
        /* best-effort */
      }
    },
  };
}
