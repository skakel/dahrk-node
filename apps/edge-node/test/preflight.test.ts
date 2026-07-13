import { test } from "node:test";
import assert from "node:assert/strict";
import type { HostFacts, PreflightDeps, RepoProbe, ToolPresence } from "../src/preflight.ts";
import {
  checkDiskSpace,
  checkRepo,
  checkTools,
  checkWorktreeRoot,
  PREFLIGHT_STAGES,
  REPORT_BASE_URL,
  runPreflight,
  synthesise,
} from "../src/preflight.ts";

// -- pure sub-checks ---------------------------------------------------------

test("checkWorktreeRoot: writable passes, unwritable is a floor failure", () => {
  assert.equal(checkWorktreeRoot(true).status, "pass");
  assert.equal(checkWorktreeRoot(false).status, "fail");
});

test("checkDiskSpace: ample passes, low warns, unknown warns", () => {
  assert.equal(checkDiskSpace(10 * 1024 * 1024 * 1024).status, "pass");
  assert.equal(checkDiskSpace(64 * 1024 * 1024).status, "warn");
  assert.equal(checkDiskSpace(undefined).status, "warn");
});

test("checkRepo: a git repo with commits passes; not-a-repo fails; empty repo is a finding", () => {
  assert.equal(checkRepo({ path: "/w", isGitRepo: true, headResolves: true, baseBranch: "main" }).status, "pass");
  assert.equal(checkRepo({ path: "/w", isGitRepo: false, headResolves: false, detail: "x" }).status, "fail");
  assert.equal(checkRepo({ path: "/w", isGitRepo: true, headResolves: false }).status, "warn");
});

test("checkTools: git is required (missing = fail); other tools missing are findings", () => {
  const all: ToolPresence = { git: true, sshKey: true, claude: true, gh: true, docker: true };
  assert.ok(checkTools(all).every((c) => c.status === "pass"));

  const noGit = checkTools({ ...all, git: false });
  assert.equal(noGit.find((c) => c.label === "git")?.status, "fail");

  const noDocker = checkTools({ ...all, docker: false });
  assert.equal(noDocker.find((c) => c.label === "docker")?.status, "warn");
});

test("synthesise: reads unsound on a fail, sound-with-warnings on a finding, all-clear otherwise", () => {
  assert.match(synthesise([{ status: "fail", label: "git", detail: "not found" }]), /unsound/i);
  assert.match(synthesise([{ status: "warn", label: "docker", detail: "not present" }]), /sound, with 1 early warning/i);
  assert.match(synthesise([{ status: "pass", label: "node" }]), /floor is sound\./i);
});

// -- runPreflight orchestration (injected deps: no host, no network) ---------

const okTools: ToolPresence = { git: true, sshKey: true, claude: true, gh: true, docker: true };
const okRepo: RepoProbe = { path: "/w/app", isGitRepo: true, headResolves: true, baseBranch: "main" };
const okHost: HostFacts = { worktreeRootWritable: true, freeDiskBytes: 50 * 1024 * 1024 * 1024, tools: okTools, repo: okRepo };

function deps(host: HostFacts, out: string[], node = "v22.0.0"): Partial<PreflightDeps> {
  return {
    nodeVersion: node,
    probeHub: async () => ({ ok: true, nodeId: "n", name: "x", tenantId: "t_a", credentialMode: "ambient" }),
    gatherHost: () => host,
    newRunId: () => "run_abc123",
    out: (l) => out.push(l),
  };
}

test("runPreflight: a sound floor exits 0, streams all five stages, and links the report", async () => {
  const out: string[] = [];
  const code = await runPreflight({ repoPath: "/w/app", hubUrl: "ws://h:1" }, deps(okHost, out));
  assert.equal(code, 0);
  const text = out.join("\n");
  // Every stage is streamed as `[n/5] <label>`.
  PREFLIGHT_STAGES.forEach((s, i) => assert.match(text, new RegExp(`\\[${i + 1}/5\\] ${s.label}`)));
  assert.match(text, /SOUND - all checks green\./);
  assert.match(text, new RegExp(`${REPORT_BASE_URL.replace(/[/.]/g, "\\$&")}/run_abc123`));
  assert.match(text, /no Linear, no OAuth, no issue/);
});

test("runPreflight: an unsound floor (not a git repo) exits 1", async () => {
  const out: string[] = [];
  const host: HostFacts = { ...okHost, repo: { path: "/w/app", isGitRepo: false, headResolves: false, detail: "not a repo" } };
  const code = await runPreflight({ repoPath: "/w/app" }, deps(host, out));
  assert.equal(code, 1);
  assert.match(out.join("\n"), /UNSOUND - 1 floor check failed/);
});

test("runPreflight: an old Node exits 1 as an unsound floor", async () => {
  const out: string[] = [];
  const code = await runPreflight({ repoPath: "/w/app" }, deps(okHost, out, "v18.19.0"));
  assert.equal(code, 1);
});

test("runPreflight: findings alone stay sound (exit 0) - a missing tool is a finding, not a failure", async () => {
  const out: string[] = [];
  const host: HostFacts = { ...okHost, tools: { ...okTools, docker: false } };
  // Supply a (reachable) hub so the only finding is the missing docker.
  const code = await runPreflight({ repoPath: "/w/app", hubUrl: "ws://h:1" }, deps(host, out));
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /SOUND with 1 finding\./);
  assert.match(text, /▲ docker: not present/);
});

test("runPreflight: an unreachable hub is a finding, never an unsound floor (issue-less run)", async () => {
  const out: string[] = [];
  const d = { ...deps(okHost, out), probeHub: async () => ({ ok: false as const, reason: "unreachable" as const, detail: "ECONNREFUSED" }) };
  const code = await runPreflight({ repoPath: "/w/app", hubUrl: "ws://h:1" }, d);
  assert.equal(code, 0, "hub down does not fail the floor");
  assert.match(out.join("\n"), /SOUND with/);
});
