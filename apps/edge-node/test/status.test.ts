/**
 * `dahrk status`: the local report (running? enrolled? can I serve a Job? what is it doing?). The renderer
 * is pure, so these drive it with gathered facts; `runStatus` is driven with fake IO (no host, no
 * supervisor, no log).
 *
 * Two of these tests are contracts rather than assertions about wording, and they are the ones to keep if
 * everything else is rewritten: `status` performs NO network request, and the only process it spawns is the
 * supervisor probe. Everything the command learned to report here (in-flight jobs, the last connection, a
 * foreign node) is a local file read precisely so that those two stay true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobLedgerEntry } from "@dahrk/edge";
import {
  lastConnection,
  renderStatus,
  resolvePresence,
  runStatus,
  type StatusDeps,
  type StatusFacts,
} from "../src/status.ts";
import { persistEnrolment, writeState } from "../src/state.ts";

const NOW = Date.parse("2026-07-13T12:00:00Z");

const facts = (over: Partial<StatusFacts> = {}): StatusFacts => ({
  clientVersion: "0.1.7",
  hubUrl: "wss://api.dahrk.ai",
  stateFile: "/home/u/.dahrk/node.json",
  state: { nodeId: "node-1", enrolToken: "sket_abc", name: "local-a1", tenantId: "t_default" },
  envToken: false,
  runtimes: [{ runtime: "claude-code", cmd: "claude", installed: true, version: "1.2.3" }],
  presence: { kind: "running", pid: 42 },
  jobs: [],
  service: { installed: true, running: true, pid: 42 },
  now: NOW,
  ...over,
});

const report = (over: Partial<StatusFacts> = {}): string => renderStatus(facts(over)).join("\n");

test("the verdict comes FIRST: the answer, before the working", () => {
  const first = renderStatus(facts()).find((l) => l.trim() !== "");
  assert.match(first ?? "", /Node running \(pid 42\)/);
});

test("the happy path names the node, its tenant, its runtime versions, and that it is idle", () => {
  const out = report();
  assert.match(out, /Enrolled\s+local-a1/);
  assert.match(out, /t_default/);
  assert.match(out, /Runtimes\s+claude-code 1\.2\.3/);
  assert.match(out, /Work\s+idle/);
});

test("the enrolment token is NEVER printed, not even a prefix", () => {
  assert.doesNotMatch(report(), /sket_/, "a partial token is still a token in a screenshot");
});

test("not enrolled says exactly how to enrol", () => {
  const out = report({ state: { nodeId: "node-1" } });
  assert.match(out, /Enrolled\s+no\s+run `dahrk start --token <token>` once to enrol/);
});

test("a token from the environment reads as enrolled-but-uncached, not as 'not enrolled'", () => {
  // The case a running service hits: the unit's env block holds the token, but nothing cached it yet.
  const out = report({ state: { nodeId: "node-1" }, envToken: true });
  assert.match(out, /Enrolled\s+via DAHRK_ENROL_TOKEN \(caches on the next successful start\)/);
});

test("a crash-loop is called out loudly, and points at the logs", () => {
  const out = report({ presence: { kind: "crashed" }, service: { installed: true, running: false } });
  assert.match(out, /NOT running/);
  assert.match(out, /crash-looping/);
  assert.match(out, /dahrk logs -f/);
});

test("a node the operator STOPPED is reported as stopped, not as a crash-loop", () => {
  // Same supervisor facts as the test above - installed, not running. Only the recorded intent differs,
  // which is the whole reason we record it: the supervisor cannot tell us why it is down.
  const out = report({ presence: { kind: "stopped" }, service: { installed: true, running: false } });
  assert.match(out, /Node stopped/);
  assert.doesNotMatch(out, /crash-looping/);
});

test("an available update is reported on the Client line, from cache", () => {
  const out = report({ update: { current: "0.1.7", latest: "0.2.1", channel: "npm" } });
  assert.match(out, /Client\s+0\.1\.7\s+\(update available: 0\.2\.1 - run `dahrk update`\)/);
});

test("no service installed, and no runtimes, each explain the consequence", () => {
  const out = report({ presence: { kind: "not-installed" }, runtimes: [] });
  assert.match(out, /Node not installed/);
  assert.match(out, /none detected - this node will serve no Jobs/);
});

// --- The two-source liveness check: a foreground / pm2 node is a REAL node --------------------

test("resolvePresence: a node held only by the pidfile is running, NOT 'not installed'", () => {
  // The bug this fixes: `status` asked launchd and nothing else, so a perfectly healthy
  // `dahrk start --foreground` (or pm2, or a container) reported as absent.
  const p = resolvePresence({ installed: false, running: false }, 4821, undefined);
  assert.deepEqual(p, { kind: "foreign", pid: 4821 });
  assert.match(renderStatus(facts({ presence: p })).join("\n"), /running under another supervisor \(pid 4821\)/);
});

test("resolvePresence: the supervisor wins when it has the node up", () => {
  assert.deepEqual(resolvePresence({ installed: true, running: true, pid: 7 }, 7, undefined), {
    kind: "running",
    pid: 7,
  });
});

test("resolvePresence: installed, down, nobody holding the lock - crashed unless it was stopped on purpose", () => {
  const down = { installed: true, running: false };
  assert.deepEqual(resolvePresence(down, undefined, undefined), { kind: "crashed" });
  assert.deepEqual(resolvePresence(down, undefined, "stopped"), { kind: "stopped" });
});

// --- In-flight work ---------------------------------------------------------------------------

const job = (over: Partial<JobLedgerEntry> = {}): JobLedgerEntry => ({
  jobId: "j1",
  runId: "r_8fa2c1",
  kind: "stage",
  stageId: "implement",
  startedAt: NOW - 4 * 60_000,
  nodePid: 42,
  ...over,
});

test("in-flight work names the run, the stage, and how long it has been going", () => {
  const out = report({ jobs: [job()] });
  assert.match(out, /Work\s+r_8fa2c1\s+\/\s+implement\s+4m/);
});

// --- Last-known connection (never a live one: status dials nothing) ---------------------------

test("lastConnection: reads the most recent EDGE_ marker, with its detail", () => {
  const at = "2026-07-13T11:00:00Z";
  const c = lastConnection([
    { msg: "EDGE_CONNECTED", time: "2026-07-13T10:00:00Z" },
    { msg: "EDGE_WELCOMED:local-a1", time: "2026-07-13T10:00:01Z" },
    { msg: "JOB_STARTED:j1", time: "2026-07-13T10:30:00Z" },
    { msg: "EDGE_DISCONNECTED:1006", time: at },
  ]);
  assert.deepEqual(c, { event: "disconnected", at: Date.parse(at), detail: "1006" });
});

test("lastConnection: a log with no connection markers yields nothing to claim", () => {
  assert.equal(lastConnection([{ msg: "JOB_STARTED:j1", time: "2026-07-13T10:00:00Z" }]), undefined);
});

test("the hub line says when it was LAST known connected, and never claims it is connected NOW", () => {
  const out = report({ connection: { event: "welcomed", at: NOW - 2 * 3600_000 } });
  assert.match(out, /Hub\s+wss:\/\/api\.dahrk\.ai\s+\(welcomed 2h ago\)/);
});

/** Fake IO: a host with a launchd service whose probe output we control, and no jobs / log / pidfile. */
function deps(over: Partial<StatusDeps> & { stateDir: string }): StatusDeps {
  const lines: string[] = [];
  return {
    platform: "darwin",
    homeDir: "/home/u",
    env: { DAHRK_STATE_DIR: over.stateDir },
    probeRuntimes: async () => [{ runtime: "claude-code", cmd: "claude", installed: true, version: "1.2.3" }],
    fileExists: () => true,
    capture: () => ({ code: 0, stdout: '\t"PID" = 79747;\n' }),
    lockedPid: () => undefined,
    jobs: () => [],
    connection: () => undefined,
    now: () => NOW,
    out: (l) => void lines.push(l),
    ...over,
  };
}

test("runStatus: a running service exits 0 and reports the pid from the supervisor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    const out: string[] = [];
    const d = deps({ stateDir: dir, out: (l) => void out.push(l) });
    persistEnrolment(d.env, { token: "sket_abc", name: "local-a1", tenantId: "t_default" });

    const code = await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://api.dahrk.ai" }, d);

    assert.equal(code, 0);
    assert.match(out.join("\n"), /Node running \(pid 79747\)/);
    assert.match(out.join("\n"), /Enrolled\s+local-a1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: a ledger entry owned by a DEAD process is not reported as live work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    const out: string[] = [];
    // The supervisor has the node up as pid 79747. The ledger still holds an entry from pid 111, a node
    // that died mid-stage. Boot reconciles that; `status` must not report it as something happening now.
    const d = deps({
      stateDir: dir,
      out: (l) => void out.push(l),
      jobs: () => [job({ nodePid: 111 }), job({ jobId: "j2", runId: "r_live", nodePid: 79747 })],
    });
    await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x" }, d);

    const text = out.join("\n");
    assert.match(text, /r_live/, "the live job is reported");
    assert.doesNotMatch(text, /r_8fa2c1/, "the dead process's leftover is not");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: installed but down exits 1, so it works as a health check in a script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    // launchd knows the label but the job is not up: a plist with no "PID" key.
    const d = deps({ stateDir: dir, capture: () => ({ code: 0, stdout: '\t"LastExitStatus" = 78;\n' }) });
    assert.equal(await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x" }, d), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: a node stopped ON PURPOSE exits 0 - status must not cry wolf as a health check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    // Byte-for-byte the supervisor facts of the crash-loop test above (unit present, no PID). The only
    // difference is that the operator ran `dahrk stop`. Reporting that as unhealthy would make every
    // deliberately-stopped node page someone.
    const d = deps({ stateDir: dir, capture: () => ({ code: 0, stdout: '\t"LastExitStatus" = 0;\n' }) });
    writeState(d.env, { desired: "stopped" });
    assert.equal(await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x" }, d), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: an update notice comes from the state file - status never dials the registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  const realFetch = globalThis.fetch;
  try {
    const out: string[] = [];
    // Any fetch at all fails the test: `status` is the command that works on a plane.
    globalThis.fetch = (() => assert.fail("status must not perform any network request")) as typeof fetch;
    const d = deps({ stateDir: dir, out: (l) => void out.push(l) });
    writeState(d.env, { updateLatest: "0.9.9", updateCheckedAt: new Date().toISOString() });

    await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x" }, d);

    assert.match(out.join("\n"), /Client\s+0\.1\.7\s+\(update available: 0\.9\.9/);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: a never-installed service is not a failure (exit 0) and is not probed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    let probed = false;
    const d = deps({
      stateDir: dir,
      fileExists: () => false,
      capture: () => {
        probed = true;
        return { code: 0, stdout: "" };
      },
    });
    assert.equal(await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x" }, d), 0);
    assert.equal(probed, false, "no unit file: do not spawn the supervisor at all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus: status never dials the hub - it only reports the URL it would dial", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    const out: string[] = [];
    const d = deps({
      stateDir: dir,
      out: (l) => void out.push(l),
      capture: (argv) => {
        assert.deepEqual(argv, ["launchctl", "list", "ai.dahrk.node"], "the only spawn is the supervisor probe");
        return { code: 0, stdout: '\t"PID" = 1;\n' };
      },
    });
    await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://api.dahrk.ai" }, d);
    assert.match(out.join("\n"), /Hub\s+wss:\/\/api\.dahrk\.ai/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runStatus --json: parseable, carries the verdict, and still withholds the token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  try {
    const out: string[] = [];
    const d = deps({ stateDir: dir, out: (l) => void out.push(l) });
    persistEnrolment(d.env, { token: "sket_abc", name: "local-a1", tenantId: "t_default" });

    const code = await runStatus({ clientVersion: "0.1.7", hubUrl: "wss://x", json: true }, d);

    assert.equal(code, 0);
    const parsed = JSON.parse(out.join("\n"));
    assert.equal(parsed.healthy, true);
    assert.deepEqual(parsed.presence, { kind: "running", pid: 79747 });
    assert.equal(parsed.state.name, "local-a1");
    assert.equal(parsed.state.enrolToken, undefined, "a status blob gets pasted into issues");
    assert.doesNotMatch(out.join("\n"), /Enrolled/, "no human framing in --json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
