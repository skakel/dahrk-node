/**
 * The single-instance lock: exactly one node process per machine.
 *
 * The node's identity is a UUID persisted at `~/.dahrk/node.json` and re-presented on every dial, so two
 * copies of the client running at once are not two nodes - they are the SAME node, dialling the hub twice
 * and racing each other for the Jobs it hands out. Nothing prevented that: you could `dahrk service
 * install` and then run `dahrk start` in a terminal, and end up with precisely that.
 *
 * So the foreground worker - the only thing that actually dials - takes a pidfile first. The lock is held
 * by whichever process is doing the work, whether it was started by launchd, by systemd, by pm2, or by
 * hand, which is what makes it a real guard rather than a supervisor-specific one.
 *
 * Staleness is decided by asking the OS, not by trusting the file: a node killed with SIGKILL (or a host
 * that lost power) leaves a pidfile behind, and a lock that a crash can wedge shut forever is worse than
 * no lock at all. `process.kill(pid, 0)` sends no signal - it just tests whether the pid is ours to signal
 * - so a dead pid is reclaimed silently and the node comes straight back up.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Read a pid out of a pidfile's contents. Anything unparseable (a truncated write, a hand-edited file)
 *  reads as "no lock", which reclaims it - a corrupt lock must never wedge the node shut. */
export function parseLock(content: string | undefined): number | undefined {
  if (!content) return undefined;
  const pid = Number(content.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Injectable IO so the lock tests without real processes or a real filesystem. */
export interface LockDeps {
  file: string;
  /** This process's pid, written into the file. */
  pid: number;
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, content: string) => void;
  removeFile: (path: string) => void;
  /** Is a pid a live process? `process.kill(pid, 0)` - a liveness test, not a signal. */
  isAlive: (pid: number) => boolean;
}

/** Held: another live node has the lock, and its pid. Taken: it is ours, and `release` gives it back. */
export type LockResult = { ok: true; release: () => void } | { ok: false; heldBy: number };

/**
 * Take the lock, or report who holds it. A pidfile naming a process that is no longer alive is stale and
 * gets reclaimed.
 *
 * There is a theoretical race here (two processes could both find the file stale and both write), which we
 * do not defend against: the cost is the double-dial we already have today, the window is microseconds,
 * and the realistic trigger - a human running `dahrk start` while the service is up - is not a race at all.
 * A lock that is right 100% of the time would need an OS-level file lock, which is not worth the
 * portability cost here.
 */
export function acquireLock(deps: LockDeps): LockResult {
  const held = parseLock(deps.readFile(deps.file));
  if (held !== undefined && held !== deps.pid && deps.isAlive(held)) {
    return { ok: false, heldBy: held };
  }
  deps.writeFile(deps.file, `${deps.pid}\n`);
  return { ok: true, release: () => deps.removeFile(deps.file) };
}

/** True when the pid is a live process. EPERM means it exists but belongs to someone else - still alive,
 *  and still a reason not to start a second node. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const defaultLockDeps = (file: string): LockDeps => ({
  file,
  pid: process.pid,
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  writeFile: (path, content) => {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content);
  },
  removeFile: (path) => rmSync(path, { force: true }),
  isAlive,
});
