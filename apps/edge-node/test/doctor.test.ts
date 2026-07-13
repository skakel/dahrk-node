import { test } from "node:test";
import assert from "node:assert/strict";
import type { HubProbeResult, RuntimeStatus } from "@dahrk/edge";
import {
  checkNode,
  checkRuntimes,
  checkHub,
  checkToken,
  formatReport,
  runDoctor,
  MIN_NODE_MAJOR,
} from "../src/doctor.ts";

test("checkNode: modern Node passes, ancient fails, garbage warns", () => {
  assert.equal(checkNode(`v${MIN_NODE_MAJOR}.3.1`).status, "pass");
  assert.equal(checkNode(`v${MIN_NODE_MAJOR + 4}.0.0`).status, "pass");
  assert.equal(checkNode("v18.19.0").status, "fail");
  assert.equal(checkNode("not-a-version").status, "warn");
});

test("checkRuntimes: at least one installed passes and lists versions; none warns", () => {
  const some: RuntimeStatus[] = [
    { runtime: "claude-code", cmd: "claude", installed: true, version: "2.1.0" },
    { runtime: "codex", cmd: "codex", installed: false },
  ];
  const pass = checkRuntimes(some);
  assert.equal(pass.status, "pass");
  assert.match(pass.detail ?? "", /claude-code \(2\.1\.0\)/);

  const none: RuntimeStatus[] = [{ runtime: "pi", cmd: "pi", installed: false }];
  assert.equal(checkRuntimes(none).status, "warn");
});

test("checkHub: no url fails; welcome passes; an enrolment rejection still counts as reachable", () => {
  assert.equal(checkHub(undefined, undefined).status, "fail");

  const ok: HubProbeResult = { ok: true, nodeId: "n", name: "x", tenantId: "t_a", credentialMode: "ambient" };
  assert.equal(checkHub("ws://h", ok).status, "pass");

  const rejected: HubProbeResult = { ok: false, reason: "rejected", code: 4401, detail: "bad" };
  assert.equal(checkHub("ws://h", rejected).status, "pass", "the hub answered - it is reachable");

  const unreachable: HubProbeResult = { ok: false, reason: "unreachable", detail: "ECONNREFUSED" };
  assert.equal(checkHub("ws://h", unreachable).status, "fail");
});

test("checkToken: absence fails; validity/expiry mapped from the probe", () => {
  assert.equal(checkToken(false, "ws://h", undefined).status, "fail");

  const ok: HubProbeResult = { ok: true, nodeId: "n", name: "x", tenantId: "t_a", credentialMode: "ambient" };
  const good = checkToken(true, "ws://h", ok);
  assert.equal(good.status, "pass");
  assert.match(good.detail ?? "", /t_a/);

  const invalid: HubProbeResult = { ok: false, reason: "rejected", code: 4401, detail: "bad" };
  assert.equal(checkToken(true, "ws://h", invalid).status, "fail");

  const poolGone: HubProbeResult = { ok: false, reason: "rejected", code: 4404, detail: "" };
  assert.equal(checkToken(true, "ws://h", poolGone).status, "fail");

  const hubUnconfigured: HubProbeResult = { ok: false, reason: "rejected", code: 4503, detail: "" };
  assert.equal(checkToken(true, "ws://h", hubUnconfigured).status, "warn", "cannot verify != invalid");

  const unreachable: HubProbeResult = { ok: false, reason: "unreachable", detail: "x" };
  assert.equal(checkToken(true, "ws://h", unreachable).status, "warn", "present but unverified");

  assert.equal(checkToken(true, undefined, undefined).status, "warn");
});

test("formatReport: a FAIL drives the summary; warnings alone still read as PASS", () => {
  const withFail = formatReport([
    { status: "pass", label: "A" },
    { status: "fail", label: "B", detail: "boom" },
  ]);
  assert.match(withFail, /✖ B: boom/);
  assert.match(withFail, /✖ 1 check failed\./);

  const warnOnly = formatReport([
    { status: "pass", label: "A" },
    { status: "warn", label: "C" },
  ]);
  assert.match(warnOnly, /▲ Passed with 1 warning\./);

  const allGreen = formatReport([{ status: "pass", label: "A" }]);
  assert.match(allGreen, /✔ All checks green\./);
});

// -- runDoctor orchestration (injected deps: no network, no host probing) ---

const okStatuses: RuntimeStatus[] = [{ runtime: "claude-code", cmd: "claude", installed: true, version: "2.1" }];

test("runDoctor: happy path returns exit 0 and prints a green report", async () => {
  const lines: string[] = [];
  const code = await runDoctor(
    { hubUrl: "ws://h:1", token: "sket_good" },
    {
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probeRuntimes: async () => okStatuses,
      probeHub: async () => ({ ok: true, nodeId: "n", name: "x", tenantId: "t_a", credentialMode: "ambient" }),
      out: (l) => lines.push(l),
    },
  );
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /✔ All checks green\./);
});

test("runDoctor: a failing check returns exit 1", async () => {
  const code = await runDoctor(
    { hubUrl: "ws://h:1", token: "sket_bad" },
    {
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probeRuntimes: async () => okStatuses,
      probeHub: async () => ({ ok: false, reason: "rejected", code: 4401, detail: "bad" }),
      out: () => {},
    },
  );
  assert.equal(code, 1);
});

test("runDoctor: with no hub url it never probes and still fails on the missing hub", async () => {
  let probed = false;
  const code = await runDoctor(
    { token: "sket_x" },
    {
      nodeVersion: `v${MIN_NODE_MAJOR}.0.0`,
      probeRuntimes: async () => okStatuses,
      probeHub: async () => {
        probed = true;
        return { ok: false, reason: "unreachable", detail: "x" };
      },
      out: () => {},
    },
  );
  assert.equal(probed, false, "no hub url -> no probe attempted");
  assert.equal(code, 1);
});
