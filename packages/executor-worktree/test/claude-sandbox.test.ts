/**
 * The Claude adapter's containment layer (DHK-392): the OS sandbox is opt-in and off by default,
 * because the SDK's doc comment and its schema disagree about what `filesystem.*` actually does. The
 * real block is the edge's `fs_confine` builtin, which `canUseTool` consults; this only pins that the
 * opt-in behaves as advertised and never quietly auto-approves Bash.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerContext } from "@dahrk/contracts";
import { sandboxOptions } from "../src/claude-adapter.js";

const ctx = (): RunnerContext =>
  ({
    config: { runtime: "claude-code", interaction: "batch" },
    workspace: {
      repoId: "r",
      gitUrl: "https://github.com/dahrkai/dahrk-node.git",
      repo: "dahrk-node",
      baseBranch: "main",
      worktreePath: "/tmp/wt",
      scratchPath: "/tmp/wt/.skakel/scratch",
    },
  }) as RunnerContext;

test("the OS sandbox is off unless the operator opts in", () => {
  delete process.env.DAHRK_SANDBOX;
  assert.deepEqual(sandboxOptions(ctx()), {});
});

test("DAHRK_SANDBOX=1 confines writes to the run, and never auto-approves Bash", () => {
  process.env.DAHRK_SANDBOX = "1";
  try {
    const opts = sandboxOptions(ctx());
    const sandbox = opts.sandbox;
    assert.ok(sandbox, "the sandbox is configured");
    assert.equal(sandbox.enabled, true);
    // A Linux node without bubblewrap must still run: fs_confine is the primary block, not this.
    assert.equal(sandbox.failIfUnavailable, false);
    // Auto-approving Bash would bypass the very canUseTool hook our block lives on.
    assert.equal(sandbox.autoAllowBashIfSandboxed, false);
    assert.deepEqual(sandbox.filesystem?.allowWrite?.slice(0, 2), ["/tmp/wt", "/tmp/wt/.skakel/scratch"]);
    assert.ok(sandbox.filesystem?.denyRead?.includes("/Volumes"), "mounted volumes stay unreadable");
  } finally {
    delete process.env.DAHRK_SANDBOX;
  }
});
