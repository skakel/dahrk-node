/**
 * The interactive idle windows (run-152a526f /): the FIRST human reply gets a longer budget
 * than subsequent inter-turn idles, both default from env and are overridable per stage via
 * `AgentConfig`, and the first-reply window is clamped to at least the inter-turn window.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerContext, WorkspaceRef } from "@dahrk/contracts";
import { interactiveIdleWindows } from "../src/runner-shared.js";

const ws: WorkspaceRef = { repoId: "r", gitUrl: "https://example.invalid/r.git", repo: "r", baseBranch: "main", worktreePath: "/tmp/r", scratchPath: "/tmp/r/.dahrk" };
const ctx = (config: Partial<RunnerContext["config"]> = {}): RunnerContext => ({
  config: { runtime: "claude-code", interaction: "interactive", ...config },
  workspace: ws,
});

/** Run `fn` with env vars set, restoring the prior values afterwards. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prior = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("defaults: the first-reply window is longer than the inter-turn idle window", () => {
  withEnv({ DAHRK_INTERACTIVE_IDLE_MS: undefined, DAHRK_INTERACTIVE_FIRST_REPLY_MS: undefined }, () => {
    const { firstReplyMs, idleMs } = interactiveIdleWindows(ctx());
    assert.equal(idleMs, 120_000);
    assert.equal(firstReplyMs, 600_000);
    assert.ok(firstReplyMs > idleMs);
  });
});

test("env overrides both windows", () => {
  withEnv({ DAHRK_INTERACTIVE_IDLE_MS: "5000", DAHRK_INTERACTIVE_FIRST_REPLY_MS: "9000" }, () => {
    const { firstReplyMs, idleMs } = interactiveIdleWindows(ctx());
    assert.equal(idleMs, 5000);
    assert.equal(firstReplyMs, 9000);
  });
});

test("per-stage AgentConfig overrides win over env", () => {
  withEnv({ DAHRK_INTERACTIVE_IDLE_MS: "5000", DAHRK_INTERACTIVE_FIRST_REPLY_MS: "9000" }, () => {
    const { firstReplyMs, idleMs } = interactiveIdleWindows(ctx({ idleMs: 111, firstReplyMs: 222 }));
    assert.equal(idleMs, 111);
    assert.equal(firstReplyMs, 222);
  });
});

test("the first-reply window is clamped to at least the inter-turn window", () => {
  withEnv({ DAHRK_INTERACTIVE_IDLE_MS: undefined, DAHRK_INTERACTIVE_FIRST_REPLY_MS: undefined }, () => {
    // A stage that (mis)configures a shorter first-reply window than the inter-turn idle must never
    // make the opening answer harder to reach than a mid-interview follow-up.
    const { firstReplyMs, idleMs } = interactiveIdleWindows(ctx({ idleMs: 300_000, firstReplyMs: 60_000 }));
    assert.equal(idleMs, 300_000);
    assert.equal(firstReplyMs, 300_000);
  });
});
