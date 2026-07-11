/**
 * The single-instance lock. Two properties, pulling against each other, and both matter:
 *  - a live holder must be respected (else we get two processes dialling as the same node);
 *  - a dead holder must NOT be (else one SIGKILL wedges the node shut until someone finds the pidfile).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireLock, parseLock, type LockDeps } from "../src/lock.ts";

/** An in-memory pidfile plus a set of pids we pretend are alive. */
function deps(over: Partial<LockDeps> & { alive?: number[]; content?: string } = {}): LockDeps & {
  written: () => string | undefined;
} {
  let file: string | undefined = over.content;
  const alive = new Set(over.alive ?? []);
  return {
    file: "/tmp/node.pid",
    pid: 100,
    readFile: () => file,
    writeFile: (_p, c) => void (file = c),
    removeFile: () => void (file = undefined),
    isAlive: (pid) => alive.has(pid),
    written: () => file,
    ...over,
  };
}

test("parseLock: a garbage or truncated pidfile reads as no lock, rather than wedging the node", () => {
  assert.equal(parseLock(undefined), undefined);
  assert.equal(parseLock(""), undefined);
  assert.equal(parseLock("not-a-pid"), undefined);
  assert.equal(parseLock("0"), undefined);
  assert.equal(parseLock("-4"), undefined);
  assert.equal(parseLock("4821\n"), 4821);
});

test("a live holder keeps the lock: the second node is refused, and told who has it", () => {
  const d = deps({ content: "4821\n", alive: [4821] });
  const result = acquireLock(d);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.heldBy, 4821);
  assert.equal(d.written(), "4821\n", "the holder's pidfile must not be trampled");
});

test("a DEAD holder's lock is reclaimed - a SIGKILLed node must not lock itself out forever", () => {
  const d = deps({ content: "4821\n", alive: [] }); // pidfile left behind by a crash
  const result = acquireLock(d);
  assert.equal(result.ok, true);
  assert.equal(d.written(), "100\n", "the new node takes the lock");
});

test("re-entering with our own pid is fine (a restart that reused the pid, or a double-take)", () => {
  const d = deps({ content: "100\n", alive: [100] });
  assert.equal(acquireLock(d).ok, true);
});

test("release gives the lock back, so the next start is not refused by a ghost", () => {
  const d = deps();
  const result = acquireLock(d);
  assert.equal(result.ok, true);
  if (result.ok) result.release();
  assert.equal(d.written(), undefined);
  assert.equal(acquireLock(deps()).ok, true);
});

test("release does NOT delete a lock that has since become someone else's", () => {
  // How this happens, and it did: we reclaim a pidfile as stale (or lose the race the comment on
  // acquireLock admits to), a second node takes the lock, and then WE exit. An unconditional delete on the
  // way out would remove the live node's pidfile, disarming the one guard against two nodes dialling the
  // hub with the same identity - and leaving nothing on disk for `dahrk stop` to find them by.
  const d = deps({ alive: [] });
  const result = acquireLock(d);
  assert.equal(result.ok, true);
  assert.equal(d.written(), "100\n");

  d.writeFile(d.file, "4821\n"); // another node takes over while we are still running

  if (result.ok) result.release();
  assert.equal(d.written(), "4821\n", "the new holder's lock must survive our exit");
});
