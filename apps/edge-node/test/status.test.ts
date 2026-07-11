/**
 * `dahrk status`: the local report (enrolled? service up? can I serve a Job?). The renderer is pure, so
 * these drive it with gathered facts; `runStatus` is driven with fake IO (no host, no supervisor).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatus, runStatus, type StatusDeps, type StatusFacts } from "../src/status.ts";
import { persistEnrolment, writeState } from "../src/state.ts";

const facts = (over: Partial<StatusFacts> = {}): StatusFacts => ({
  clientVersion: "0.1.7",
  hubUrl: "wss://api.dahrk.ai",
  stateFile: "/home/u/.dahrk/node.json",
  state: { nodeId: "node-1", enrolToken: "sket_abc", name: "local-a1", tenantId: "t_default" },
  envToken: false,
  runtimes: ["claude-code"],
  service: { installed: true, running: true, pid: 42 },
  ...over,
});

const report = (over: Partial<StatusFacts> = {}): string => renderStatus(facts(over)).join("\n");

test("the happy path names the node, its tenant, and the running service", () => {
  const out = report();
  assert.match(out, /Enrolled\s+yes, as local-a1/);
  assert.match(out, /Tenant\s+t_default/);
  assert.match(out, /Node\s+running \(pid 42\)/);
  assert.match(out, /Runtimes\s+claude-code/);
});

test("the enrolment token is NEVER printed, not even a prefix", () => {
  assert.doesNotMatch(report(), /sket_/, "a partial token is still a token in a screenshot");
});

test("not enrolled says exactly how to enrol", () => {
  const out = report({ state: { nodeId: "node-1" } });
  assert.match(out, /Enrolled\s+no - run `dahrk start --token <token>` once to enrol/);
  assert.doesNotMatch(out, /Tenant/, "no tenant is known before the first welcome");
});

test("a token from the environment reads as enrolled-but-uncached, not as 'not enrolled'", () => {
  // The case a running service hits: the unit's env block holds the token, but nothing cached it yet.
  const out = report({ state: { nodeId: "node-1" }, envToken: true });
  assert.match(out, /Enrolled\s+yes, via DAHRK_ENROL_TOKEN \(caches on the next successful start\)/);
});

test("installed-but-not-running is called out loudly, with the log to look at", () => {
  const out = report({ service: { installed: true, running: false }, logHint: "dahrk logs -f" });
  assert.match(out, /INSTALLED BUT NOT RUNNING/);
  assert.match(out, /check the logs: dahrk logs -f/);
});

test("a node the operator STOPPED is reported as stopped, not as a crash-loop", () => {
  // Same supervisor facts as the test above - installed, not running. Only the recorded intent differs,
  // which is the whole reason we record it: the supervisor cannot tell us why it is down.
  const out = report({
    service: { installed: true, running: false },
    state: { nodeId: "node-1", enrolToken: "sket_abc", desired: "stopped" },
  });
  assert.match(out, /Node\s+stopped - run `dahrk start` to bring it back/);
  assert.doesNotMatch(out, /CRASH|INSTALLED BUT NOT RUNNING/);
});

test("an available update is reported on the Client line, from cache", () => {
  const out = report({ update: { current: "0.1.7", latest: "0.2.1", channel: "npm" } });
  assert.match(out, /Client\s+0\.1\.7 \(update available: 0\.2\.1 - run `dahrk update`\)/);
});

test("no service installed, and no runtimes, each explain the consequence", () => {
  const out = report({ service: { installed: false, running: false }, runtimes: [] });
  assert.match(out, /Node\s+not installed - run `dahrk start` to run it always-on/);
  assert.match(out, /Runtimes\s+none detected - this node will serve no Jobs/);
});

/** Fake IO: a host with a launchd service whose probe output we control. */
function deps(over: Partial<StatusDeps> & { stateDir: string }): StatusDeps {
  const lines: string[] = [];
  return {
    platform: "darwin",
    homeDir: "/home/u",
    env: { DAHRK_STATE_DIR: over.stateDir },
    detectRuntimes: async () => ["claude-code"],
    fileExists: () => true,
    capture: () => ({ code: 0, stdout: '\t"PID" = 79747;\n' }),
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
    assert.match(out.join("\n"), /Node\s+running \(pid 79747\)/);
    assert.match(out.join("\n"), /Enrolled\s+yes, as local-a1/);
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

    assert.match(out.join("\n"), /Client\s+0\.1\.7 \(update available: 0\.9\.9/);
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
