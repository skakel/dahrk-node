/**
 * Worktree reaper (DHK-371).
 *
 * The edge creates one git worktree per run and, before this, never removed any of them: the only
 * teardown path was an LRU retention pass that (a) was disabled unless an operator set a policy, and
 * (b) consulted an IN-MEMORY map, so every worktree created by a previous process was orphaned for
 * ever. On one node that reached 92 registered worktrees and 65 GB.
 *
 * There is no `run-finished` frame in the hub -> edge protocol, so the edge cannot simply be told when
 * a run is over. This reaper is therefore the primary mechanism, and it is deliberately built to be
 * restart-safe: it reconciles what is ON DISK and what git has REGISTERED, never process-local state.
 *
 * It also clears the two things that wedge future runs:
 *   - a stale worktree registration keeps claiming its branch name for ever, so the next run of the
 *     same issue cannot `worktree add` that branch;
 *   - a worktree whose branch ref was deleted under it has an unborn HEAD and can never be reused.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Milliseconds. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface ReapPolicy {
  /** Keep at most this many worktrees; the idlest are reaped first. */
  maxRuns?: number;
  /** Reap a worktree idle for longer than this. */
  maxIdleMs?: number;
  /**
   * Never reap a worktree touched more recently than this, whatever else says. This is the only guard
   * against reaping a live run belonging to ANOTHER node process sharing the same worktrees dir (there
   * is no IPC between them), so it must stay comfortably longer than the longest plausible stage.
   */
  activityGraceMs?: number;
  /** Report what would be reaped, change nothing. */
  dryRun?: boolean;
}

export type ReapReason = "broken" | "idle" | "over-count";

export interface ReapedWorktree {
  runId: string;
  path: string;
  reason: ReapReason;
}

export interface ReapReport {
  scanned: number;
  reaped: ReapedWorktree[];
  /** Skipped because busy, or inside the activity grace. */
  skipped: number;
  errors: string[];
}

export interface ReaperOptions {
  worktreesDir: string;
  mirrorsDir: string;
  /** True while a run is executing a stage on this node. A busy run is never reaped. */
  isBusy?: (runId: string) => boolean;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

const DEFAULTS: Required<Omit<ReapPolicy, "dryRun">> = {
  // Deliberately non-optional defaults. "No policy configured" used to mean "never collect anything",
  // which is precisely how the disk reached 65 GB. Absent config must mean sane collection, not none.
  maxRuns: 20,
  maxIdleMs: 6 * HOUR,
  activityGraceMs: 30 * MINUTE,
};

const noop = { info: () => {}, warn: () => {} };

const gitOk = (cwd: string, args: string[]): boolean => {
  try {
    execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
};
const gitOut = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" });

/**
 * Canonicalise a path so the two sources of truth agree. `readdir` yields the path as configured (e.g.
 * `/var/folders/...` on macOS, or any symlinked worktrees dir), while git reports the fully resolved one
 * (`/private/var/folders/...`). Without this they do not dedupe: the same worktree is counted twice,
 * which breaks the count cap and makes the reaper try to remove it twice.
 */
const canonical = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p; // already deleted: the raw path is the best we have, and removal is a no-op anyway
  }
};

/**
 * The last time a run actually did anything, as a durable on-disk clock. `.skakel/scratch/state.json`
 * is rewritten by the stage runner on every stage entry and exit, so its mtime survives a process
 * restart (which the in-memory map did not). Falls back to the worktree dir's own mtime.
 */
function lastUsedMs(worktreePath: string): number {
  const candidates = [join(worktreePath, ".skakel", "scratch", "state.json"), worktreePath];
  let newest = 0;
  for (const p of candidates) {
    try {
      newest = Math.max(newest, statSync(p).mtimeMs);
    } catch {
      /* missing: ignore */
    }
  }
  return newest;
}

/** Worktrees each mirror has registered, including ones whose directory is already gone. */
function registeredWorktrees(mirror: string): string[] {
  let out: string;
  try {
    out = gitOut(mirror, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => canonical(l.slice(9).trim()))
    .filter((p) => p && p !== canonical(mirror));
}

export function createWorktreeReaper(opts: ReaperOptions) {
  const log = opts.logger ?? noop;
  const mirrors = (): string[] => {
    try {
      return readdirSync(opts.mirrorsDir)
        .map((d) => join(opts.mirrorsDir, d))
        .filter((m) => gitOk(m, ["rev-parse", "--git-dir"]));
    } catch {
      return [];
    }
  };

  /** Which mirror owns a worktree path (needed to remove it); undefined when nothing claims it. */
  const ownerOf = (worktreePath: string, all: Map<string, string[]>): string | undefined => {
    for (const [mirror, paths] of all) if (paths.includes(worktreePath)) return mirror;
    return undefined;
  };

  return {
    async reap(policy: ReapPolicy = {}): Promise<ReapReport> {
      const maxRuns = policy.maxRuns ?? DEFAULTS.maxRuns;
      const maxIdleMs = policy.maxIdleMs ?? DEFAULTS.maxIdleMs;
      const graceMs = policy.activityGraceMs ?? DEFAULTS.activityGraceMs;
      const dryRun = policy.dryRun ?? false;
      const report: ReapReport = { scanned: 0, reaped: [], skipped: 0, errors: [] };
      const now = Date.now();

      // Prune first: drops admin entries whose directory has already vanished, so a hand-deleted
      // worktree stops claiming its branch name. This alone fixes a class of "already used by
      // worktree" failures.
      const registered = new Map<string, string[]>();
      for (const m of mirrors()) {
        gitOk(m, ["worktree", "prune"]);
        registered.set(m, registeredWorktrees(m));
      }

      // Candidates = what git still has registered, UNION what is on disk. The union matters: a
      // worktree whose mirror was deleted is invisible to git but still occupies the disk.
      const onDisk = (() => {
        try {
          return readdirSync(opts.worktreesDir).map((d) => canonical(join(opts.worktreesDir, d)));
        } catch {
          return [];
        }
      })();
      // Both sides canonicalised, so the same worktree from `readdir` and from git dedupes to one entry.
      const candidates = [...new Set([...onDisk, ...[...registered.values()].flat()])];

      type Entry = { path: string; runId: string; idleMs: number; broken: boolean; mirror?: string };
      const entries: Entry[] = [];
      for (const path of candidates) {
        report.scanned++;
        const runId = path.split("/").pop() ?? path;
        if (opts.isBusy?.(runId)) {
          report.skipped++;
          continue;
        }
        const idleMs = now - lastUsedMs(path);
        if (idleMs < graceMs) {
          // Might belong to a live run in another process. Never touch it.
          report.skipped++;
          continue;
        }
        // Broken = the worktree cannot resolve HEAD (its branch ref was deleted under it). It is
        // unusable for any future run and only serves to hold its branch name hostage.
        const broken = !existsSync(path) || !gitOk(path, ["rev-parse", "--verify", "-q", "HEAD"]);
        entries.push({ path, runId, idleMs, broken, ...(ownerOf(path, registered) ? { mirror: ownerOf(path, registered)! } : {}) });
      }

      // Idlest first, so the over-count sweep evicts the least recently useful.
      entries.sort((a, b) => b.idleMs - a.idleMs);
      const keep = entries.filter((e) => !e.broken && e.idleMs <= maxIdleMs);
      const doomed: Array<Entry & { reason: ReapReason }> = [];
      for (const e of entries) {
        if (e.broken) doomed.push({ ...e, reason: "broken" });
        else if (e.idleMs > maxIdleMs) doomed.push({ ...e, reason: "idle" });
      }
      // Then trim whatever survives down to maxRuns, idlest first.
      const survivors = keep.filter((e) => !doomed.some((d) => d.path === e.path));
      for (const e of survivors.slice(0, Math.max(0, survivors.length - maxRuns))) {
        doomed.push({ ...e, reason: "over-count" });
      }

      for (const d of doomed) {
        if (dryRun) {
          log.info(`reaper (dry-run): would reap ${d.runId} (${d.reason}, idle ${Math.round(d.idleMs / MINUTE)}m)`);
          report.reaped.push({ runId: d.runId, path: d.path, reason: d.reason });
          continue;
        }
        try {
          // Remove via the owning mirror where known, so the ADMIN ENTRY goes too (an `rm -rf` alone
          // leaves the registration, and the registration is what blocks the next run of that issue).
          if (d.mirror) {
            gitOk(d.mirror, ["worktree", "remove", "--force", d.path]);
          }
          rmSync(d.path, { recursive: true, force: true });
          if (d.mirror) gitOk(d.mirror, ["worktree", "prune"]);
          report.reaped.push({ runId: d.runId, path: d.path, reason: d.reason });
        } catch (e) {
          report.errors.push(`${d.runId}: ${(e as Error).message}`);
        }
      }

      if (report.reaped.length) {
        log.info(`reaper: reaped ${report.reaped.length} worktree(s), skipped ${report.skipped}`);
      }
      return report;
    },
  };
}
