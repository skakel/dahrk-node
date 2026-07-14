/**
 * What a node does when the hub REJECTS its enrolment token - the DHK incident where a node sat in a
 * launchd respawn loop for hours, dialling the hub six times a minute with a token that had been revoked,
 * while the working token sat unread in `~/.dahrk/node.json`.
 *
 * Three things have to hold, and each one of them was false:
 *
 *  1. A rejection must not be retried. Re-presenting the same token gets the same answer, so a reconnect
 *     on 4401 is a pure hot loop.
 *  2. Exiting is not a way to stop that loop. The client exited 78 and expected its supervisor to stop it;
 *     systemd and pm2 do, but launchd's `KeepAlive` takes no exit code and simply respawned it. So the
 *     node has to stop dialling IN-PROCESS - it parks.
 *  3. A parked node must heal itself. Re-enrolment writes a new token to disk; the node must notice it and
 *     reconnect without a restart, because "restart it" is exactly the instruction nobody was there to give.
 *
 * The hub here is a real `WebSocketServer` that closes with 4401 unless the `hello` carries GOOD_TOKEN,
 * which is precisely what the real hub does with a revoked one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { decode, encode, type EdgeToHub } from "@dahrk/contracts";
import { ENROLMENT_REJECTED_EXIT_CODE, startEdgeNode } from "../src/ws-client.js";

const GOOD_TOKEN = "sket_good";
const REVOKED_TOKEN = "sket_revoked";

const welcome = encode({
  type: "welcome",
  nodeId: "n1",
  name: "brave-otter",
  tenantId: "t_node",
  credentialMode: "ambient",
  heartbeatMs: 5000,
  allowedRepos: [],
});

/** Capture the client's stdout markers without swallowing them. */
function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    lines.push(String(chunk));
    return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  return { lines, restore: () => void (process.stdout.write = orig) };
}

const markers = (lines: string[], prefix: string): number =>
  lines
    .join("")
    .split("\n")
    .filter((l) => l.includes(`"msg":"${prefix}`) || l.startsWith(prefix)).length;

const waitFor = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A hub that welcomes GOOD_TOKEN and closes 4401 on anything else - i.e. a revoked token. */
async function withHub(
  fn: (ctx: { url: string; hellos: string[] }) => Promise<void>,
): Promise<void> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", r));
  const hellos: string[] = [];
  wss.on("connection", (sock) => {
    sock.on("message", (raw) => {
      const msg = decode<EdgeToHub>(raw.toString());
      if (msg.type !== "hello") return;
      hellos.push((msg as { enrolToken?: string }).enrolToken ?? "");
      if ((msg as { enrolToken?: string }).enrolToken === GOOD_TOKEN) sock.send(welcome);
      else sock.close(4401, "invalid or expired enrolment token");
    });
  });
  const { port } = wss.address() as AddressInfo;
  try {
    await fn({ url: `ws://127.0.0.1:${port}`, hellos });
  } finally {
    wss.close();
  }
}

test("a rejected node with a token source PARKS: it stops dialling instead of hot-looping", async () => {
  await withHub(async ({ url, hellos }) => {
    const abort = new AbortController();
    const cap = captureLog();
    const before = process.exitCode;
    try {
      // A node whose disk holds the same revoked token: there is nothing to heal with, so it must simply
      // stay parked - and above all must NOT keep dialling.
      await startEdgeNode({
        hubUrl: url,
        runtimes: ["claude-code"],
        enrolToken: REVOKED_TOKEN,
        refreshEnrolToken: () => REVOKED_TOKEN,
        parkPollMs: 20,
        signal: abort.signal,
      });
      await waitFor(() => markers(cap.lines, "EDGE_PARKED") === 1);

      // The whole bug, in one assertion: give it far longer than the poll interval and it must still have
      // dialled exactly once. The old client dialled forever, once per supervisor respawn.
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(hellos.length, 1, "a parked node must not re-present a token the hub already rejected");
      assert.equal(markers(cap.lines, "EDGE_REJECTED"), 1);

      // Parking is not dying: `startEdgeNode` resolved (the process stays up, holding the park poll), and
      // no fatal exit code was set. Exiting is what launchd would have undone.
      assert.equal(process.exitCode, before);
    } finally {
      abort.abort();
      cap.restore();
    }
  });
});

test("a parked node SELF-HEALS when a fresh token lands on disk - no restart", async () => {
  await withHub(async ({ url, hellos }) => {
    const abort = new AbortController();
    const cap = captureLog();
    // The disk. Starts holding the revoked token, then the operator re-enrols.
    let onDisk = REVOKED_TOKEN;
    try {
      await startEdgeNode({
        hubUrl: url,
        runtimes: ["claude-code"],
        enrolToken: REVOKED_TOKEN,
        refreshEnrolToken: () => onDisk,
        parkPollMs: 20,
        signal: abort.signal,
      });
      await waitFor(() => markers(cap.lines, "EDGE_PARKED") === 1);

      // `dahrk start --token <good>` writes the new token. Nothing restarts the node.
      onDisk = GOOD_TOKEN;

      await waitFor(() => markers(cap.lines, "EDGE_WELCOMED") === 1);
      assert.equal(markers(cap.lines, "EDGE_UNPARKED"), 1);
      assert.deepEqual(hellos, [REVOKED_TOKEN, GOOD_TOKEN], "it must re-dial with the NEW token, once");
    } finally {
      abort.abort();
      cap.restore();
    }
  });
});

test("without a token source (ephemeral / CI) a rejection is still fatal: exit 78, no park", async () => {
  await withHub(async ({ url, hellos }) => {
    const abort = new AbortController();
    const cap = captureLog();
    const before = process.exitCode;
    try {
      await assert.rejects(
        startEdgeNode({
          hubUrl: url,
          runtimes: ["claude-code"],
          enrolToken: REVOKED_TOKEN,
          // no refreshEnrolToken: nowhere to heal from, so fail fast and let CI see it
          signal: abort.signal,
        }),
        /rejected edge enrolment \(4401\)/,
      );
      assert.equal(process.exitCode, ENROLMENT_REJECTED_EXIT_CODE);
      assert.equal(markers(cap.lines, "EDGE_PARKED"), 0);
      assert.equal(hellos.length, 1);
    } finally {
      process.exitCode = before;
      abort.abort();
      cap.restore();
    }
  });
});

test("stopping a PARKED node works: the park poll is torn down on abort", async () => {
  await withHub(async ({ url }) => {
    const abort = new AbortController();
    const cap = captureLog();
    try {
      await startEdgeNode({
        hubUrl: url,
        runtimes: ["claude-code"],
        enrolToken: REVOKED_TOKEN,
        refreshEnrolToken: () => GOOD_TOKEN, // would unpark on the next tick, if we let it
        parkPollMs: 50,
        signal: abort.signal,
      });
      await waitFor(() => markers(cap.lines, "EDGE_PARKED") === 1);

      // `dahrk stop` on a parked node. The poll is the one timer deliberately holding the process alive,
      // so leaving it running would make a parked node unstoppable - and would let it reconnect after the
      // operator had stopped it.
      abort.abort();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(markers(cap.lines, "EDGE_UNPARKED"), 0);
    } finally {
      cap.restore();
    }
  });
});
