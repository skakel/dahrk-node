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
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { decode, encode, type EdgeToHub, type JobRequest, type PushJob } from "@dahrk/contracts";
import { startEdgeNode } from "../src/ws-client.js";

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
  serverOpts: { autoPong?: boolean; heartbeatMs?: number } = {},
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

    // The hub re-sends the same Job (a re-arm tick, or a reconnect flush).
    ctx.toEdge({ type: "job", job: foreignJob("job-1") });
    await waitFor(() => marker(ctx.lines, "JOB_REPLAY:") === 1);

    // The runner was never invoked a second time, and the hub got the cached result again.
    assert.equal(marker(ctx.lines, "JOB_STARTED:"), 1);
    assert.equal(ctx.inbound.filter((m) => m.type === "result").length, 2);
  });
});

test("a push frame for a finished push replays the cached result", async () => {
  await withEdge(async (ctx) => {
    ctx.toEdge({ type: "push", job: foreignPush("push-1") });
    await waitFor(() => ctx.inbound.some((m) => m.type === "push-result"));
    assert.equal(marker(ctx.lines, "PUSH_STARTED:"), 1);

    ctx.toEdge({ type: "push", job: foreignPush("push-1") });
    await waitFor(() => marker(ctx.lines, "PUSH_REPLAY:") === 1);

    assert.equal(marker(ctx.lines, "PUSH_STARTED:"), 1);
    assert.equal(ctx.inbound.filter((m) => m.type === "push-result").length, 2);
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
