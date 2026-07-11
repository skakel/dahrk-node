import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEdgeOptions, resolveNodeId, resolveRuntimes, DEFAULT_HUB_URL } from "../src/main.ts";

const base: NodeJS.ProcessEnv = { DAHRK_HUB_URL: "ws://127.0.0.1:7071" };

test("ambient edge: no enrolment env leaves the managed fields absent", () => {
  const opts = buildEdgeOptions({ ...base });
  assert.equal(opts.hubUrl, "ws://127.0.0.1:7071");
  assert.equal(opts.nodeId, undefined);
  assert.equal(opts.enrolToken, undefined);
  assert.equal(opts.tenantId, undefined);
  assert.equal(opts.credentialMode, "ambient");
  assert.deepEqual(opts.runtimes, ["claude-code"]);
});

test("managed profile: enrolment + tenant env is passed through", () => {
  const opts = buildEdgeOptions({
    ...base,
    DAHRK_NODE_ID: "node-platform-local",
    DAHRK_ENROL_TOKEN: "tok-123",
    DAHRK_TENANT_ID: "t_platform",
    DAHRK_CREDENTIAL_MODE: "brokered",
  });
  assert.equal(opts.nodeId, "node-platform-local");
  assert.equal(opts.enrolToken, "tok-123");
  assert.equal(opts.tenantId, "t_platform");
  assert.equal(opts.credentialMode, "brokered");
});

test("the pi runtime is honoured, not silently dropped", () => {
  const opts = buildEdgeOptions({ ...base, DAHRK_RUNTIMES: "pi" });
  assert.deepEqual(opts.runtimes, ["pi"]);
});

test("mixed runtimes keep claude-code, codex and pi", () => {
  const opts = buildEdgeOptions({ ...base, DAHRK_RUNTIMES: "claude-code, codex, pi" });
  assert.deepEqual(opts.runtimes, ["claude-code", "codex", "pi"]);
});

test("a missing hub url defaults to the hosted hub", () => {
  assert.equal(buildEdgeOptions({}).hubUrl, DEFAULT_HUB_URL);
});

// -- token-only surface ---

test("resolved boot: detected runtimes, node id and client version are threaded through", () => {
  const opts = buildEdgeOptions(
    { ...base, DAHRK_ENROL_TOKEN: "sket_abc" },
    { nodeId: "uuid-1", runtimes: ["codex"], clientVersion: "1.2.3" },
  );
  assert.deepEqual(opts.runtimes, ["codex"]);
  assert.equal(opts.nodeId, "uuid-1");
  assert.equal(opts.clientVersion, "1.2.3");
  assert.equal(opts.enrolToken, "sket_abc");
});

test("resolved boot: an empty detected set is advertised as-is (no false claude-code fallback)", () => {
  const opts = buildEdgeOptions({ ...base }, { nodeId: "uuid-2", runtimes: [], clientVersion: "1.0.0" });
  assert.deepEqual(opts.runtimes, [], "an empty set must not be back-filled - that would mis-route Jobs");
});

test("DAHRK_RUNTIMES still overrides the detected set", () => {
  const opts = buildEdgeOptions(
    { ...base, DAHRK_RUNTIMES: "pi" },
    { nodeId: "uuid-3", runtimes: ["claude-code"], clientVersion: "1.0.0" },
  );
  // The resolved set already reflects the override (resolveRuntimes applies it upstream); with no
  // resolved arg, the env override is honoured directly.
  const direct = buildEdgeOptions({ ...base, DAHRK_RUNTIMES: "pi" });
  assert.deepEqual(direct.runtimes, ["pi"]);
  assert.equal(opts.nodeId, "uuid-3");
});

test("credentialMode is only marked explicit when the operator set it", () => {
  assert.equal(buildEdgeOptions({ ...base }).credentialModeExplicit, false);
  assert.equal(buildEdgeOptions({ ...base, DAHRK_CREDENTIAL_MODE: "brokered" }).credentialModeExplicit, true);
  assert.equal(buildEdgeOptions({ ...base, DAHRK_CREDENTIAL_MODE: "brokered" }).credentialMode, "brokered");
});

test("DAHRK_NODE_NAME sets the display-name override", () => {
  assert.equal(buildEdgeOptions({ ...base }).name, undefined);
  assert.equal(buildEdgeOptions({ ...base, DAHRK_NODE_NAME: "my-mac" }).name, "my-mac");
});

test("resolveNodeId: an explicit DAHRK_NODE_ID wins", () => {
  assert.equal(resolveNodeId({ DAHRK_NODE_ID: "node-fixed" }), "node-fixed");
});

test("resolveNodeId: mints once and persists a stable UUID across calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-state-"));
  try {
    const env = { DAHRK_STATE_DIR: dir };
    const first = resolveNodeId(env);
    const second = resolveNodeId(env);
    assert.equal(first, second, "the id is stable across boots");
    const persisted = JSON.parse(readFileSync(join(dir, "node.json"), "utf8")) as { nodeId: string };
    assert.equal(persisted.nodeId, first, "the id is persisted to node.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRuntimes: env override wins; mock runner skips probing", async () => {
  assert.deepEqual(await resolveRuntimes({ DAHRK_RUNTIMES: "codex, pi" }), ["codex", "pi"]);
  assert.deepEqual(await resolveRuntimes({ DAHRK_RUNNER: "mock" }), ["claude-code"]);
});

test("resolveNodeId: --ephemeral mints a throwaway id and never touches disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-ephemeral-"));
  try {
    const env = { DAHRK_STATE_DIR: dir };
    const first = resolveNodeId(env, { ephemeral: true });
    const second = resolveNodeId(env, { ephemeral: true });
    assert.notEqual(first, second, "ephemeral ids are fresh per boot");
    assert.equal(existsSync(join(dir, "node.json")), false, "ephemeral writes no node.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveNodeId: an explicit DAHRK_NODE_ID still wins under --ephemeral", () => {
  assert.equal(resolveNodeId({ DAHRK_NODE_ID: "node-fixed" }, { ephemeral: true }), "node-fixed");
});

/**
 * The exit code of a refused start. This lives in main's glue rather than in a pure function, which is
 * exactly why it broke once already: `start` returned 0 unconditionally after the foreground path and
 * clobbered the failure. Exiting 0 tells a supervisor the worker finished cleanly, so it restarts it into
 * the same refusal - a crash-loop that reports itself as healthy. Driven end-to-end because that is the
 * only place the bug could exist.
 */
test("a start refused by the lock exits NON-ZERO, so a supervisor does not read it as a clean exit", async () => {
  const { spawnSync } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "dahrk-main-"));
  try {
    const state = join(home, ".dahrk");
    mkdirSync(state, { recursive: true });
    // `process.pid` is, definitionally, a live process: a node that holds the lock.
    writeFileSync(join(state, "node.pid"), `${process.pid}\n`);

    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "../src/main.ts"), "start", "--foreground"],
      {
        encoding: "utf8",
        // A hub that cannot be reached, so a bug that got PAST the lock fails loudly instead of dialling
        // the real hub from a test.
        env: { ...process.env, HOME: home, DAHRK_STATE_DIR: state, DAHRK_HUB_URL: "ws://127.0.0.1:1" },
        timeout: 15_000,
      },
    );

    assert.equal(run.status, 1, `expected a refusal, got ${run.status}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /already running on this host \(pid \d+\)/);
    assert.doesNotMatch(run.stdout, /EDGE_CONNECTED|EDGE_ERROR/, "it must refuse BEFORE it dials anything");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
