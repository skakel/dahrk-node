/**
 * Brokered runtime-auth injection for the Claude adapter (DHK-89). A managed / Docker-isolated node
 * has no ambient `claude` login, so the hub mints the provider key into `runtimeEnv` and the adapter
 * must pass it as the CLI subprocess `env`. This pins the pure option helper `runtimeEnvOptions`
 * (used by every `query()` site via `baseOptions`): brokered nodes get the key in `env` over an
 * inherited process.env; ambient nodes get no `env` (the SDK keeps its process.env default / login).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerContext } from "@dahrk/contracts";
import { runtimeEnvOptions } from "../src/claude-adapter.js";

const ctx = (over: Partial<RunnerContext> = {}): RunnerContext =>
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
    ...over,
  }) as RunnerContext;

test("ambient node (no runtimeEnv): no env option, so the SDK keeps the operator's ambient login", () => {
  assert.deepEqual(runtimeEnvOptions(ctx()), {});
});

test("brokered node: the minted provider key is set in env, over an inherited process.env", () => {
  process.env.DHK89_SENTINEL = "keep-me";
  try {
    const opts = runtimeEnvOptions(ctx({ runtimeEnv: { ANTHROPIC_API_KEY: "sk-brokered" } }));
    assert.ok(opts.env, "env is populated on a brokered node");
    assert.equal(opts.env?.ANTHROPIC_API_KEY, "sk-brokered", "the brokered key is injected");
    // env REPLACES the subprocess environment, so PATH and other inherited vars must survive.
    assert.equal(opts.env?.PATH, process.env.PATH, "PATH is carried through from process.env");
    assert.equal(opts.env?.DHK89_SENTINEL, "keep-me", "other inherited vars survive");
  } finally {
    delete process.env.DHK89_SENTINEL;
  }
});

test("brokered runtimeEnv overrides an ambient value of the same key", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ambient";
  try {
    const opts = runtimeEnvOptions(ctx({ runtimeEnv: { ANTHROPIC_API_KEY: "sk-brokered" } }));
    assert.equal(opts.env?.ANTHROPIC_API_KEY, "sk-brokered", "the brokered key wins over the ambient one");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
