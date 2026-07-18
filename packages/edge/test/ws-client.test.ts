/**
 * The edge WebSocket client's re-dispatch safety and socket liveness (DHK-359). We stand up a
 * throwaway `WebSocketServer` that plays the hub - welcome, then `job` / `push` frames - and drive a
 * real `startEdgeNode` against it, asserting on the line-tagged markers it writes to stdout.
 *
 * The hub re-sends the same jobId on its dispatch deadline, on every re-arm tick (DHK-337), and on
 * each reconnect. A re-send of a FINISHED job must replay the cached result rather than start a
 * second runner at full token cost. Jobs here fail their tenant/allowlist guard, which returns a
 * result before any git or runner work, so the tests are hermetic and fast.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { decode, encode, type EdgeToHub, type JobRequest, type PushJob } from "@dahrk/contracts";
import { startEdgeNode } from "../src/ws-client.js";
import { fileJobLedger, jobLedgerFile, type JobLedger, type JobLedgerEntry } from "../src/job-ledger.js";

const NODE_TENANT = "t_node";

const welcome = encode({
  type: "welcome",
  nodeId: "n1",
  name: "brave-otter",
  tenantId: NODE_TENANT,
  credentialMode: "ambient",
  heartbeatMs: 5000,
  allowedRepos: [],
});

/** A Job for another tenant: the runner's defence-in-depth guard fails it before touching git. */
const foreignJob = (jobId: string): JobRequest =>
  ({
    runId: "run-1",
    stageId: "plan",
    jobId,
    awakeableId: `awk-${jobId}`,
    tenantId: "t_someone_else",
    agentConfig: { runtime: "claude-code" },
    timeout: 60,
  }) as unknown as JobRequest;

/** A push for a repo outside the node's allowlist: fails before touching git. */
const foreignPush = (jobId: string): PushJob =>
  ({
    runId: "run-1",
    jobId,
    awakeableId: `awk-${jobId}`,
    tenantId: NODE_TENANT,
    branch: "dahrk/run-1",
    message: "wip",
    workspaceRef: { repoId: "repo-not-served", gitUrl: "", baseBranch: "main", repo: "x/y" },
  }) as unknown as PushJob;

/** Capture the client's stdout markers (JOB_STARTED / JOB_REPLAY / ...) while still printing them. */
function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    lines.push(String(chunk));
    return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  return { lines, restore: () => void (process.stdout.write = orig) };
}

const marker = (lines: string[], prefix: string): number =>
  lines.join("").split("\n").filter((l) => l.startsWith(prefix)).length;

const waitFor = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Stand up a hub-side WS server, run the edge against it, then tear both down. */
async function withEdge(
  fn: (ctx: {
    url: string;
    lines: string[];
    /** Frames the hub received from the edge. */
    inbound: EdgeToHub[];
    /** Send a frame to the edge (once one is connected). */
    toEdge: (frame: unknown) => void;
    connections: number;
  }) => Promise<void>,
  serverOpts: { autoPong?: boolean; heartbeatMs?: number; jobLedger?: JobLedger } = {},
): Promise<void> {
  const wss = new WebSocketServer({ port: 0, autoPong: serverOpts.autoPong ?? true });
  await new Promise<void>((r) => wss.on("listening", r));

  const inbound: EdgeToHub[] = [];
  const state = { connections: 0 };
  let live: WebSocket | undefined;
  wss.on("connection", (sock) => {
    state.connections++;
    live = sock;
    sock.on("message", (raw) => {
      const msg = decode<EdgeToHub>(raw.toString());
      inbound.push(msg);
      if (msg.type === "hello") sock.send(welcome);
    });
  });

  const { port } = wss.address() as AddressInfo;
  const abort = new AbortController();
  const cap = captureLog();
  try {
    await startEdgeNode({
      hubUrl: `ws://127.0.0.1:${port}`,
      runtimes: ["claude-code"],
      servesRepoIds: ["repo-served"],
      enrolToken: "sket_test",
      signal: abort.signal,
      ...(serverOpts.heartbeatMs ? { heartbeatMs: serverOpts.heartbeatMs } : {}),
      ...(serverOpts.jobLedger ? { jobLedger: serverOpts.jobLedger } : {}),
    });
    await waitFor(() => inbound.some((m) => m.type === "hello"));
    await fn({
      url: `ws://127.0.0.1:${port}`,
      lines: cap.lines,
      inbound,
      toEdge: (frame) => live?.send(encode(frame as never)),
      get connections() {
        return state.connections;
      },
    } as never);
  } finally {
    abort.abort();
    cap.restore();
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }
}

test("a job frame for a finished job replays the cached result and never re-runs it", async () => {
  await withEdge(async (ctx) => {
    ctx.toEdge({ type: "job", job: foreignJob("job-1") });
    await waitFor(() => ctx.inbound.some((m) => m.type === "result"));
    assert.equal(marker(ctx.lines, "JOB_STARTED:"), 1);

    // The hub re-sends the same Job (a re-arm tick, or a reconnect flush). Wait on the frame reaching
    // the hub, not on the JOB_REPLAY marker: the marker is written the instant `send()` queues the
    // frame, so waiting on it races the frame's delivery and the count below can still be in flight.
    ctx.toEdge({ type: "job", job: foreignJob("job-1") });
    await waitFor(() => ctx.inbound.filter((m) => m.type === "result").length === 2);

    // The hub got the cached result again, off the replay path, and the runner never ran a second time.
    assert.equal(marker(ctx.lines, "JOB_REPLAY:"), 1);
    assert.equal(marker(ctx.lines, "JOB_STARTED:"), 1);
  });
});

test("a push frame for a finished push replays the cached result", async () => {
  await withEdge(async (ctx) => {
    ctx.toEdge({ type: "push", job: foreignPush("push-1") });
    await waitFor(() => ctx.inbound.some((m) => m.type === "push-result"));
    assert.equal(marker(ctx.lines, "PUSH_STARTED:"), 1);

    // As above: the hub-side frame is the observable to wait on, not the stdout marker.
    ctx.toEdge({ type: "push", job: foreignPush("push-1") });
    await waitFor(() => ctx.inbound.filter((m) => m.type === "push-result").length === 2);

    assert.equal(marker(ctx.lines, "PUSH_REPLAY:"), 1);
    assert.equal(marker(ctx.lines, "PUSH_STARTED:"), 1);
  });
});

test("a job frame for an unknown jobId still runs (the genuine-recovery path)", async () => {
  await withEdge(async (ctx) => {
    ctx.toEdge({ type: "job", job: foreignJob("job-1") });
    await waitFor(() => ctx.inbound.some((m) => m.type === "result"));

    ctx.toEdge({ type: "job", job: foreignJob("job-2") });
    await waitFor(() => marker(ctx.lines, "JOB_STARTED:") === 2);
    assert.equal(marker(ctx.lines, "JOB_REPLAY:"), 0);
  });
});

test("a hub that stops answering pings is terminated and reconnected, not left a zombie", async () => {
  await withEdge(
    async (ctx) => {
      // The socket is up but the hub never pongs. Three missed beats (3 x 100ms) must terminate it,
      // and the close handler's 500ms backoff must dial a second connection.
      await waitFor(() => marker(ctx.lines, "EDGE_STALE:") >= 1, 3000);
      await waitFor(() => ctx.connections >= 2, 3000);
    },
    { autoPong: false, heartbeatMs: 100 },
  );
});

// --- cancel is a durable, acked ledger item (DHK-421) ---------------------------------------------

/** Cancel-ack frames the hub received (DHK-421, `@dahrk/contracts@0.4.0`). */
const cancelAcks = (inbound: EdgeToHub[]): Array<Extract<EdgeToHub, { type: "cancel-ack" }>> =>
  inbound.filter((m): m is Extract<EdgeToHub, { type: "cancel-ack" }> => m.type === "cancel-ack");

test("a cancel frame is acknowledged, even for a job the node is not running (a harmless settle)", async () => {
  await withEdge(async (ctx) => {
    // No such job is in flight (nothing was dispatched): the runner-abort is a no-op, but the ack MUST
    // still be sent so the hub settles its durable `${jobId}-cancel` row rather than dead-lettering it.
    ctx.toEdge({ type: "cancel", jobId: "job-x" });
    await waitFor(() => cancelAcks(ctx.inbound).length === 1);
    assert.equal(cancelAcks(ctx.inbound)[0]!.jobId, "job-x");
    assert.equal(marker(ctx.lines, "JOB_CANCEL:"), 1);
  });
});

test("a cancel-ack is cached and re-sent on reconnect, so a hub roll still settles the cancel", async () => {
  await withEdge(
    async (ctx) => {
      ctx.toEdge({ type: "cancel", jobId: "job-c" });
      await waitFor(() => cancelAcks(ctx.inbound).length === 1);

      // The hub stops answering pings: the edge terminates the zombie socket and redials. On the new
      // connection it replays every cached cancel-ack, so a cancel the hub is still trying to settle
      // (its row leased/queued because the first ack was lost to the roll) is acked again.
      await waitFor(() => ctx.connections >= 2, 3000);
      await waitFor(() => cancelAcks(ctx.inbound).length >= 2, 3000);
      assert.ok(
        cancelAcks(ctx.inbound).every((f) => f.jobId === "job-c"),
        "every replayed ack is for the cancelled job",
      );
    },
    { autoPong: false, heartbeatMs: 100 },
  );
});

// --- announcing in-flight jobs on hello (DHK-416) --------------------------------------------------

test("an idle node announces an EMPTY in-flight list, not an absent one", async () => {
  // The wire contract makes these mean different things: absent = "I am too old to know", which leaves
  // the hub on its old re-dispatch behaviour; empty = "I positively have nothing in flight". A node that
  // can answer must answer, or the hub's adoption path stays dormant for ever.
  await withEdge(async (ctx) => {
    const hello = ctx.inbound.find((m) => m.type === "hello");
    assert.ok(hello);
    assert.deepEqual((hello as { inFlightJobs?: unknown }).inFlightJobs, []);
  });
});

test("a job the previous process died holding is reconciled at boot, and never announced", async () => {
  // The restart case. The old process's runner is dead - the AbortController, the trace stream and the
  // elicit router all died with it - so the job is NOT running and announcing it would tell the hub to
  // keep waiting on a stage that nothing is executing. It must be dropped from the ledger and left out
  // of `hello`, so the hub's lease lapses and the stage is re-dispatched onto a live node.
  const dir = mkdtempSync(join(tmpdir(), "dahrk-ws-ledger-"));
  try {
    const file = jobLedgerFile(dir);
    const ledger = fileJobLedger(file);
    ledger.upsert({
      jobId: "job-from-the-dead-process",
      runId: "run-dead",
      kind: "stage",
      stageId: "build",
      payloadVersion: "v1",
      // No worktreePath: nothing to reconcile on disk, so the entry is simply dropped. (The worktree
      // reset itself is covered against a real git repo in git-service.test.ts.)
      startedAt: Date.now() - 60_000,
      nodePid: process.pid + 1, // a pid that is not ours: a previous process wrote this
    });
    assert.equal(ledger.all().length, 1, "precondition: the stale entry is on disk");

    await withEdge(
      async (ctx) => {
        const hello = ctx.inbound.find((m) => m.type === "hello");
        assert.ok(hello);
        assert.deepEqual(
          (hello as { inFlightJobs?: unknown }).inFlightJobs,
          [],
          "a job whose runner died is never announced as in-flight",
        );
        assert.equal(marker(ctx.lines, "EDGE_INTERRUPTED:"), 1, "and the interruption is reported");
        assert.deepEqual(ledger.all(), [], "the stale entry is cleared, so the next boot is clean too");
      },
      { jobLedger: fileJobLedger(file) },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a running job is written through to the ledger with its payloadVersion, and removed when it ends", async () => {
  // The write-through is what makes the hub-roll case work. While a stage runs, the node holds it in
  // `running` (which `hello` announces, so a new hub build ADOPTS it rather than re-dispatching) and on
  // disk (so a crash can be reconciled). `payloadVersion` has to survive both hops or the hub's adoption
  // gate version-rejects the job and kills it.
  //
  // A recording ledger rather than a real one: what matters is the sequence of calls the job path makes,
  // and a genuinely long-running stage would need a real worktree and a real agent (that is what the
  // end-to-end check on a live hub is for).
  const calls: Array<{ op: "upsert" | "remove" | "clear"; entry?: JobLedgerEntry; jobId?: string }> = [];
  const spy: JobLedger = {
    all: () => [],
    stale: () => [],
    upsert: (entry) => void calls.push({ op: "upsert", entry }),
    remove: (jobId) => void calls.push({ op: "remove", jobId }),
    clear: () => void calls.push({ op: "clear" }),
  };

  await withEdge(
    async (ctx) => {
      const job = { ...foreignJob("job-ledgered"), payloadVersion: "v1" } as JobRequest;
      ctx.toEdge({ type: "job", job });
      await waitFor(() => ctx.inbound.some((m) => m.type === "result"));

      const upsert = calls.find((c) => c.op === "upsert");
      assert.ok(upsert, "the job was ledgered when it started");
      assert.equal(upsert.entry?.jobId, "job-ledgered");
      assert.equal(upsert.entry?.payloadVersion, "v1", "the hub's payload version survived to the ledger");
      assert.equal(upsert.entry?.kind, "stage");
      assert.equal(upsert.entry?.stageId, "plan");
      assert.equal(upsert.entry?.nodePid, process.pid, "stamped with OUR pid: a later boot can tell it apart");

      // And it is taken back out the moment the result is sent. A finished job that stayed in the ledger
      // would be announced on the next `hello`, asking the hub to adopt a stage nothing is running.
      assert.ok(
        calls.some((c) => c.op === "remove" && c.jobId === "job-ledgered"),
        "the finished job was removed from the ledger",
      );
      assert.ok(
        calls.findIndex((c) => c.op === "upsert") < calls.findIndex((c) => c.op === "remove"),
        "upsert precedes remove",
      );
    },
    { jobLedger: spy },
  );
});
