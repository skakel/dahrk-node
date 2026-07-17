import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
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

/**
 * `--no-service` is the opt-out for users who supervise the node themselves (the `install.sh` flag of
 * the same name forwards to it). It must enrol - leave the token on disk - but stop short of installing
 * the always-on service, and it must not dial the hub. Driven end-to-end because "did it install a
 * service / dial out?" is a property of main's glue, not of any pure function.
 */
test("`start --no-service` enrols without installing a service and without dialling the hub", async () => {
  const home = mkdtempSync(join(tmpdir(), "dahrk-noservice-"));
  try {
    const state = join(home, ".dahrk");
    mkdirSync(state, { recursive: true });
    // The token already on disk, so enrolment is a no-op that needs no network.
    writeFileSync(join(state, "node.json"), JSON.stringify({ nodeId: "n", enrolToken: "sket_here" }));

    const clean: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith("DAHRK_") && !k.startsWith("SKAKEL_")) clean[k] = v;
    }
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "../src/main.ts"), "start", "--token", "sket_here", "--no-service"],
      {
        encoding: "utf8",
        // An unreachable hub, so a bug that tried to dial or install a service fails loudly rather than
        // touching the real one.
        env: { ...clean, HOME: home, DAHRK_STATE_DIR: state, DAHRK_HUB_URL: "ws://127.0.0.1:1" },
        timeout: 15_000,
      },
    );

    assert.equal(run.status, 0, `expected a clean enrol-only exit, got ${run.status}: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /not installing a service|no service/i);
    assert.doesNotMatch(run.stdout + run.stderr, /EDGE_CONNECTED|EDGE_ERROR/, "it must not dial the hub");
    assert.ok(!existsSync(join(home, "Library", "LaunchAgents", "ai.dahrk.node.plist")), "no launchd unit written");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// -- `dahrk repo add` end-to-end (spawned CLI against a fake HTTP hub) --------

/** A fake hub config surface: records POSTs to the repositories endpoint, dedupes by id, and answers
 *  201 for a fresh id / 200 for a repeat - the idempotency contract `registerRepo` reads. */
function fakeHub(): Promise<{ server: Server; port: number; creates: () => number; posts: () => number }> {
  const seen = new Set<string>();
  let posts = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/config/api/repositories")) {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      posts += 1;
      const repo = JSON.parse(body) as { id: string };
      const fresh = !seen.has(repo.id);
      seen.add(repo.id);
      res.statusCode = fresh ? 201 : 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(repo));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, creates: () => seen.size, posts: () => posts });
    });
  });
}

/** A throwaway git repo with a commit, an origin remote, and a known branch. */
function repoWithOrigin(origin: string, branch = "main"): string {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-repoadd-"));
  const git = (...args: string[]): void => void execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("checkout", "-q", "-b", branch);
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("remote", "add", "origin", origin);
  return dir;
}

// `dahrk repo add` runs against `process.cwd()`, so the spawned CLI's cwd is the repo under test - which
// is a temp dir with no node_modules. Resolve tsx's loader to an absolute path so `--import` still finds
// it from there (a bare `tsx` specifier would resolve relative to the temp cwd and fail).
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

/** Spawn `dahrk repo add` in `cwd`, with an isolated HOME/state and no ambient SSH agent.
 *
 *  Async (not spawnSync): the fake hub runs in THIS process, so a synchronous spawn would block the event
 *  loop and the child's POST would never be answered - a deadlock. */
function spawnRepoAdd(
  cwd: string,
  home: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // Strip any inherited DAHRK_*/SKAKEL_* config (this suite may itself run inside an enrolled node), so the
  // child's only enrolment/hub state is what the test sets - otherwise an ambient DAHRK_ENROL_TOKEN would
  // make an "un-enrolled" node look enrolled.
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("DAHRK_") && !k.startsWith("SKAKEL_")) clean[k] = v;
  }
  const env: NodeJS.ProcessEnv = {
    ...clean,
    HOME: home,
    DAHRK_STATE_DIR: join(home, ".dahrk"),
    ...extraEnv,
  };
  delete env.SSH_AUTH_SOCK; // so sshKeyPresent() is deterministic (no key -> HTTPS conversion)
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", tsxLoader, join(import.meta.dirname, "../src/main.ts"), "repo", "add"],
      { cwd, env, timeout: 15_000 },
      (err, stdout, stderr) => {
        const status = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
        resolve({ status, stdout, stderr });
      },
    );
  });
}

/** Cache an enrolment token in node.json so the node counts as enrolled. */
function enrol(home: string, token = "sket_test"): void {
  const state = join(home, ".dahrk");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "node.json"), JSON.stringify({ nodeId: "n", enrolToken: token }));
}

test("repo add: registers the cwd repo once, and a re-run is a no-op with no duplicate", async () => {
  const hub = await fakeHub();
  const home = mkdtempSync(join(tmpdir(), "dahrk-home-"));
  const repo = repoWithOrigin("https://github.com/org/repo.git", "trunk");
  try {
    enrol(home);
    const hubUrl = `ws://127.0.0.1:${hub.port}`;

    const first = await spawnRepoAdd(repo, home, { DAHRK_HUB_URL: hubUrl });
    assert.equal(first.status, 0, `first run failed: ${first.stdout}${first.stderr}`);
    assert.match(first.stdout, /[Rr]egistered/);

    const second = await spawnRepoAdd(repo, home, { DAHRK_HUB_URL: hubUrl });
    assert.equal(second.status, 0, `second run failed: ${second.stdout}${second.stderr}`);
    assert.match(second.stdout, /already registered/i);

    assert.equal(hub.posts(), 2, "both runs POST");
    assert.equal(hub.creates(), 1, "but only one repo is ever created - the id deduped");
  } finally {
    hub.server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("repo add: outside a git repo fails with an actionable message", async () => {
  const home = mkdtempSync(join(tmpdir(), "dahrk-home-"));
  const notARepo = mkdtempSync(join(tmpdir(), "dahrk-notrepo-"));
  try {
    enrol(home);
    const run = await spawnRepoAdd(notARepo, home, { DAHRK_HUB_URL: "ws://127.0.0.1:1" });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout + run.stderr, /not a git repository/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("repo add: a repo with no origin fails and says to add one", async () => {
  const home = mkdtempSync(join(tmpdir(), "dahrk-home-"));
  const dir = mkdtempSync(join(tmpdir(), "dahrk-noorigin-"));
  try {
    enrol(home);
    execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
    const run = await spawnRepoAdd(dir, home, { DAHRK_HUB_URL: "ws://127.0.0.1:1" });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout + run.stderr, /origin/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo add: an un-enrolled node fails telling you to enrol first", async () => {
  const home = mkdtempSync(join(tmpdir(), "dahrk-home-"));
  const repo = repoWithOrigin("https://github.com/org/repo.git");
  try {
    // No enrol() call: there is no cached token.
    const run = await spawnRepoAdd(repo, home, { DAHRK_HUB_URL: "ws://127.0.0.1:1" });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout + run.stderr, /enrol/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("repo add: an SSH origin with no key is converted to HTTPS with a warning, and still registers", async () => {
  const hub = await fakeHub();
  const home = mkdtempSync(join(tmpdir(), "dahrk-home-"));
  const repo = repoWithOrigin("git@github.com:org/repo.git");
  try {
    enrol(home);
    const run = await spawnRepoAdd(repo, home, { DAHRK_HUB_URL: `ws://127.0.0.1:${hub.port}` });
    assert.equal(run.status, 0, `run failed: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /HTTPS/);
    assert.equal(hub.creates(), 1);
  } finally {
    hub.server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
