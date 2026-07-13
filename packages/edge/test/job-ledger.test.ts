/**
 * The node's durable in-flight job ledger (DHK-416) and the `hello` announcement it feeds.
 *
 * Two things are worth testing hard here, and they are not the happy path:
 *
 *  1. **The announce filter.** The hub's adoption gate version-rejects a job it cannot version-check -
 *     it marks the dispatch dead, cancels the runner and fails the awakeable. So announcing a job with
 *     no `payloadVersion` KILLS a healthy stage. The filter that prevents that is a safety property.
 *  2. **Corruption tolerance.** The ledger exists to survive a `kill -9`, so the file it reads back may
 *     well be one that was half-written when the process died. Every unreadable shape must degrade to
 *     "I know nothing" (which costs a re-dispatch) rather than throw (which would wedge the boot).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announceableJobs, fileJobLedger, jobLedgerFile, nullJobLedger, type JobLedgerEntry } from "../src/job-ledger.js";

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-ledger-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const entry = (over: Partial<JobLedgerEntry> = {}): JobLedgerEntry => ({
  jobId: "job-1",
  runId: "run-1",
  kind: "stage",
  stageId: "build",
  payloadVersion: "v1",
  worktreePath: "/tmp/wt/run-1",
  branch: "feature/issue-DHK-416",
  gitUrl: "https://github.com/x/y.git",
  startedAt: 1_700_000_000_000,
  nodePid: 4242,
  ...over,
});

test("an entry round-trips through the file, and remove/clear take it back out", () => {
  withDir((dir) => {
    const ledger = fileJobLedger(jobLedgerFile(dir));
    ledger.upsert(entry());
    ledger.upsert(entry({ jobId: "job-2", stageId: "test" }));
    assert.deepEqual(
      ledger.all().map((e) => e.jobId),
      ["job-1", "job-2"],
    );
    assert.equal(ledger.all()[0]?.payloadVersion, "v1");
    assert.equal(ledger.all()[0]?.branch, "feature/issue-DHK-416");

    ledger.remove("job-1");
    assert.deepEqual(
      ledger.all().map((e) => e.jobId),
      ["job-2"],
    );
    ledger.clear();
    assert.deepEqual(ledger.all(), []);
  });
});

test("upsert replaces an existing entry rather than duplicating it", () => {
  withDir((dir) => {
    const ledger = fileJobLedger(jobLedgerFile(dir));
    ledger.upsert(entry({ stageId: "build" }));
    ledger.upsert(entry({ stageId: "review" }));
    assert.equal(ledger.all().length, 1);
    assert.equal(ledger.all()[0]?.stageId, "review");
  });
});

test("a fresh ledger reads as empty rather than throwing when the file does not exist", () => {
  withDir((dir) => {
    assert.deepEqual(fileJobLedger(jobLedgerFile(dir)).all(), []);
  });
});

test("a corrupt ledger reads as empty, so a half-written file cannot wedge the boot", () => {
  withDir((dir) => {
    const file = jobLedgerFile(dir);
    // Exactly what a `kill -9` mid-write would leave behind under a naive writer.
    writeFileSync(file, '[{"jobId":"job-1","runId":"run-1","ki');
    const warnings: string[] = [];
    assert.deepEqual(fileJobLedger(file, (m) => warnings.push(m)).all(), []);
  });
});

test("a ledger that is valid JSON but not an array reads as empty", () => {
  withDir((dir) => {
    const file = jobLedgerFile(dir);
    writeFileSync(file, '{"jobId":"job-1"}');
    assert.deepEqual(fileJobLedger(file).all(), []);
  });
});

test("one malformed entry is dropped without costing the good ones", () => {
  withDir((dir) => {
    const file = jobLedgerFile(dir);
    writeFileSync(
      file,
      JSON.stringify([
        entry({ jobId: "good-1" }),
        { jobId: "bad-no-run-id", kind: "stage", startedAt: 1, nodePid: 1 },
        { jobId: "bad-kind", runId: "r", kind: "sideways", startedAt: 1, nodePid: 1 },
        entry({ jobId: "good-2" }),
      ]),
    );
    assert.deepEqual(
      fileJobLedger(file)
        .all()
        .map((e) => e.jobId),
      ["good-1", "good-2"],
    );
  });
});

test("stale() returns only what a PREVIOUS process was holding", () => {
  withDir((dir) => {
    const ledger = fileJobLedger(jobLedgerFile(dir));
    ledger.upsert(entry({ jobId: "mine", nodePid: process.pid }));
    ledger.upsert(entry({ jobId: "the-dead-process", nodePid: process.pid + 1 }));
    assert.deepEqual(
      ledger.stale(process.pid).map((e) => e.jobId),
      ["the-dead-process"],
    );
  });
});

test("the write is atomic and leaves no temp file behind", () => {
  withDir((dir) => {
    const file = jobLedgerFile(dir);
    const ledger = fileJobLedger(file);
    ledger.upsert(entry());
    // A `.tmp` sibling surviving the write would mean the rename did not happen, i.e. a reader could
    // observe a partial file - the exact failure this ledger exists to survive.
    assert.deepEqual(readdirSync(dir), ["jobs.json"]);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 1);
  });
});

test("the ledger is written 0600: it sits beside node.json, which holds a token", () => {
  withDir((dir) => {
    const file = jobLedgerFile(dir);
    fileJobLedger(file).upsert(entry());
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

test("an unwritable path warns and is swallowed: losing the ledger must not break the run in hand", () => {
  withDir((dir) => {
    // The unwritable path is a file standing where a directory has to be, which yields a deterministic
    // ENOTDIR. Two other tempting choices are wrong: a `chmod 0500` dir does not stop ROOT (and CI runs
    // as root, so it would simply succeed), and a path under `/proc` HANGS - `mkdirSync` recursive into
    // procfs never returns on Linux, which is exactly how this test wedged CI for 14 minutes rather than
    // failing. Structural impossibility beats permissions.
    const notADir = join(dir, "in-the-way");
    writeFileSync(notADir, "i am a file, not a directory\n");

    const warnings: string[] = [];
    const ledger = fileJobLedger(join(notADir, "jobs.json"), (m) => warnings.push(m));
    ledger.upsert(entry());

    assert.deepEqual(ledger.all(), [], "nothing was persisted, and nothing threw");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /could not persist the job ledger/);
  });
});

test("the null ledger persists nothing, which is the pre-DHK-416 behaviour exactly", () => {
  const ledger = nullJobLedger();
  ledger.upsert(entry());
  assert.deepEqual(ledger.all(), []);
  assert.deepEqual(ledger.stale(process.pid), []);
});

// --- the announce filter: the safety property ------------------------------------------------------

test("a version-stamped stage is announced, so the hub can adopt it", () => {
  assert.deepEqual(announceableJobs([entry({ jobId: "job-1", payloadVersion: "v1" })]), [
    { jobId: "job-1", payloadVersion: "v1" },
  ]);
});

test("a job with NO payloadVersion is never announced: announcing it would make the hub kill it", () => {
  // A push (PushJob carries no version) and a stage from a pre-DHK-415 hub both land here. The hub's
  // gate treats an absent version as unsupported and responds by marking the dispatch dead, cancelling
  // the runner and failing the awakeable - so silence is the only safe answer for a job that is running
  // perfectly well.
  const nothing = announceableJobs([
    entry({ jobId: "the-push", kind: "push", payloadVersion: undefined }),
    entry({ jobId: "legacy-stage", payloadVersion: undefined }),
  ]);
  assert.deepEqual(nothing, []);
});

test("a mixed set announces only the version-stamped jobs", () => {
  assert.deepEqual(
    announceableJobs([
      entry({ jobId: "stage-a", payloadVersion: "v1" }),
      entry({ jobId: "push-b", kind: "push", payloadVersion: undefined }),
      entry({ jobId: "stage-c", payloadVersion: "v1" }),
    ]),
    [
      { jobId: "stage-a", payloadVersion: "v1" },
      { jobId: "stage-c", payloadVersion: "v1" },
    ],
  );
});

test("an idle node announces an empty list, which says 'nothing in flight', not 'I do not know'", () => {
  // The wire contract distinguishes the two: absent means unknown (a node too old to answer, for which
  // the hub keeps its old re-dispatch behaviour), empty means a positive "I have none". We always know.
  assert.deepEqual(announceableJobs([]), []);
});
