/**
 * The node's side of telemetry.
 *
 * The load-bearing test in here is the ceiling: **the hub can ask for less than the operator allows, and
 * never for more.** This client is Apache-2.0 and the person running it can read `log-shipper.ts`, so a
 * hub that could force logs out of a machine against its operator's stated wishes would be a lie anyone
 * could catch us in. If that test is ever weakened, the published privacy policy becomes false.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NodeLogRecord } from "@dahrk/contracts";
import { collectHealth, HealthCounters } from "../src/health.js";
import { ceilingFromEnv, LogShipper, shipperStream } from "../src/log-shipper.js";

const rec = (level: number, msg: string): NodeLogRecord => ({ level, time: "2026-07-11T10:00:00Z", msg });

// --- The ceiling ----------------------------------------------------------------------------------

test("DAHRK_TELEMETRY=off means off, whatever the hub asks for", () => {
  const s = new LogShipper({ ceiling: ceilingFromEnv({ DAHRK_TELEMETRY: "off" } as NodeJS.ProcessEnv) });
  // The hub says "ship me everything, and report health".
  s.setPolicy({ health: true, logs: "debug" });
  // The operator said no. The operator wins.
  assert.deepEqual(s.current(), { health: false, logs: "off" });

  s.offer(rec(50, "an error the hub will never see"));
  assert.equal(s.pending(), 0);
});

test("DAHRK_TELEMETRY=health permits health but never logs", () => {
  const s = new LogShipper({ ceiling: ceilingFromEnv({ DAHRK_TELEMETRY: "health" } as NodeJS.ProcessEnv) });
  s.setPolicy({ health: true, logs: "debug" });
  assert.deepEqual(s.current(), { health: true, logs: "off" });
  s.offer(rec(50, "nope"));
  assert.equal(s.pending(), 0);
});

test("with no local ceiling, the hub's policy applies as sent", () => {
  const s = new LogShipper({ ceiling: ceilingFromEnv({} as NodeJS.ProcessEnv) });
  s.setPolicy({ health: true, logs: "warn" });
  assert.deepEqual(s.current(), { health: true, logs: "warn" });
});

test("a node whose hub says nothing ships no logs (an older hub, or none)", () => {
  // The default must be the SAFE one: an old hub sends no `telemetry` on welcome, and the node must not
  // read that silence as permission.
  const s = new LogShipper();
  assert.equal(s.current().logs, "off");
  s.offer(rec(50, "an error"));
  assert.equal(s.pending(), 0);
});

// --- Shipping behaviour ---------------------------------------------------------------------------

test("only records at or above the policy level are shipped", () => {
  const s = new LogShipper({ initial: { health: true, logs: "warn" } });
  s.offer(rec(30, "info: routine"));
  s.offer(rec(40, "warn: something"));
  s.offer(rec(50, "error: something"));
  assert.equal(s.pending(), 2, "info should not have been queued at a warn threshold");
});

test("records are held when the socket is down, and sent when it comes back", () => {
  const sent: NodeLogRecord[][] = [];
  let open = false;
  const s = new LogShipper({ initial: { health: true, logs: "warn" } });
  s.attach((records) => {
    if (!open) return false;
    sent.push(records);
    return true;
  });

  s.offer(rec(50, "died while disconnected"));
  s.flush();
  assert.deepEqual(sent, [], "nothing can be sent while the socket is down");
  assert.equal(s.pending(), 1, "and the record must be KEPT, not lost");

  open = true;
  s.flush();
  assert.equal(sent[0]?.[0]?.msg, "died while disconnected");
  assert.equal(s.pending(), 0);
});

test("a disconnected node does not grow without bound - it drops the OLDEST and counts them", () => {
  // A node offline for an hour must not OOM on its own diagnostics, which would be a spectacularly stupid
  // way to lose a node. Oldest-first: a node in trouble emits a burst, and the newest lines describe what
  // it is doing NOW, which is what you are looking at the dashboard to find out.
  const s = new LogShipper({ initial: { health: true, logs: "warn" }, bufferMax: 3 });
  for (let i = 0; i < 10; i++) s.offer(rec(50, `line ${i}`));

  assert.equal(s.pending(), 3);
  assert.equal(s.dropped, 7, "drops must be counted, never silently swallowed");

  const sent: NodeLogRecord[][] = [];
  s.attach((r) => {
    sent.push(r);
    return true;
  });
  s.flush();
  assert.deepEqual(
    sent[0]?.map((r) => r.msg),
    ["line 7", "line 8", "line 9"],
    "the newest records are the ones kept",
  );
});

test("turning shipping off discards what was queued under the old permission", () => {
  const s = new LogShipper({ initial: { health: true, logs: "warn" } });
  s.offer(rec(50, "gathered under a permission now withdrawn"));
  assert.equal(s.pending(), 1);
  s.setPolicy({ health: true, logs: "off" });
  assert.equal(s.pending(), 0);
});

test("the pino stream maps a log line onto the wire shape, keeping the correlation ids", () => {
  const s = new LogShipper({ initial: { health: true, logs: "warn" } });
  const stream = shipperStream(s);
  stream.write(
    JSON.stringify({ level: 50, time: "2026-07-11T10:00:00Z", msg: "JOB_ERROR:build boom", runId: "run-1", stageId: "build" }),
  );

  const sent: NodeLogRecord[][] = [];
  s.attach((r) => {
    sent.push(r);
    return true;
  });
  s.flush();
  assert.equal(sent[0]?.[0]?.runId, "run-1");
  assert.equal(sent[0]?.[0]?.stageId, "build");
});

test("the pino stream never throws on a malformed line", () => {
  const stream = shipperStream(new LogShipper({ initial: { health: true, logs: "debug" } }));
  assert.doesNotThrow(() => stream.write("not json at all"));
  assert.doesNotThrow(() => stream.write("{}"));
});

// --- Health ---------------------------------------------------------------------------------------

test("the health report carries counts and numbers, and nothing that could name a customer's code", () => {
  // The claim the privacy policy makes on our behalf. If a field is ever added that CAN carry a path or a
  // message, this test should be what stops it - and the fix is to move it to the log channel, not to
  // relax this.
  const counters = new HealthCounters();
  counters.activeJobs = 2;
  counters.connectCount = 7;
  counters.worktreeCount = 3;
  counters.recordError("git");
  counters.recordError("git");
  counters.recordError("runtime");

  const health = collectHealth({
    counters,
    clientVersion: "0.2.0",
    runtimes: ["claude-code"],
    worktreesDir: "/tmp",
  });

  assert.equal(health.activeJobs, 2);
  assert.equal(health.connectCount, 7);
  assert.equal(health.worktreeCount, 3);
  assert.equal(health.clientVersion, "0.2.0");
  assert.deepEqual(health.errors, { git: 2, runtime: 1 });

  // Every value is a number, a boolean, or a short enum/version string. Nothing free-text.
  const flat = JSON.stringify(health);
  assert.ok(!flat.includes("/Users"), "a path reached the health report");
  assert.ok(!flat.includes("github.com"), "a repo reference reached the health report");
  for (const [k, v] of Object.entries(health)) {
    if (k === "clientVersion") continue;
    if (k === "runtimes") continue;
    if (k === "errors") continue;
    assert.equal(typeof v, "number", `${k} must be a number - free text does not belong in health`);
  }
});

test("uptime and error counts accumulate; a disk read that fails simply omits the field", () => {
  const counters = new HealthCounters();
  const health = collectHealth({
    counters,
    clientVersion: "0.2.0",
    runtimes: [],
    // A path that cannot be stat'd: the node must still report everything else rather than refuse.
    worktreesDir: "/definitely/not/a/real/path/anywhere",
  });
  assert.equal(health.diskFreeBytes, undefined);
  assert.ok(typeof health.uptimeSec === "number");
  assert.equal(health.errors, undefined, "no errors yet means the field is absent, not zero-filled");
});
