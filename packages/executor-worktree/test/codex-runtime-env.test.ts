/**
 * Brokered runtime-auth injection for the Codex adapter (DHK-89). A managed / Docker-isolated node
 * has no ambient `codex` login, so the hub mints the provider key into `runtimeEnv` and the adapter
 * must pass it as the Codex CLI `env` (used at the single `new Codex()` construction site). This pins
 * the pure option helper `runtimeEnvOptions`: brokered nodes get the key in a defined-only `env` over
 * an inherited process.env; ambient nodes get no `env` (the SDK keeps its process.env default).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerContext } from "@dahrk/contracts";
import { runtimeEnvOptions } from "../src/codex-adapter.js";

const ctx = (over: Partial<RunnerContext> = {}): RunnerContext =>
  ({
    config: { runtime: "codex", interaction: "batch" },
    workspace: { worktreePath: "/tmp/wt", branch: "main" },
    ...over,
  }) as RunnerContext;

test("ambient node (no runtimeEnv): no env option, so the SDK keeps the operator's ambient login", () => {
  assert.deepEqual(runtimeEnvOptions(ctx()), {});
});

test("brokered node: the minted provider key is set in env, over an inherited process.env", () => {
  process.env.DHK89_SENTINEL = "keep-me";
  try {
    const opts = runtimeEnvOptions(ctx({ runtimeEnv: { OPENAI_API_KEY: "sk-brokered" } }));
    assert.ok(opts.env, "env is populated on a brokered node");
    assert.equal(opts.env?.OPENAI_API_KEY, "sk-brokered", "the brokered key is injected");
    // env REPLACES the subprocess environment, so PATH and other inherited vars must survive.
    assert.equal(opts.env?.PATH, process.env.PATH, "PATH is carried through from process.env");
    assert.equal(opts.env?.DHK89_SENTINEL, "keep-me", "other inherited vars survive");
  } finally {
    delete process.env.DHK89_SENTINEL;
  }
});

test("env is a defined-only Record<string,string> (no undefined values leak from process.env)", () => {
  const opts = runtimeEnvOptions(ctx({ runtimeEnv: { OPENAI_API_KEY: "sk" } }));
  assert.ok(opts.env);
  for (const v of Object.values(opts.env ?? {})) assert.equal(typeof v, "string");
});
