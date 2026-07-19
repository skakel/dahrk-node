/**
 * DHK-344 / DHK-223 tool-parity invariant: injecting the AskUserQuestion shadow tool must not deny any
 * other tool. An interactive stage can still call arbitrary tools (Bash/Write/Read) while an
 * AskUserQuestion is present - the elicit interception is additive (mcpServers / toolAliases /
 * allowedTools), and the sole arbiter of a denial stays the edge policy (`ctx.authorizeToolUse`). This
 * exercises the extracted pure `interactiveCanUseTool` decision the interactive options wire to their
 * `canUseTool`, SDK-free (the repo does not mock the model `query()`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { PolicyOutcome, RunnerContext } from "@dahrk/contracts";
import { interactiveCanUseTool } from "../src/claude-adapter.js";
import { STAGE_COMPLETE_TOOL_NAME } from "../src/stage-complete-tool.js";
import { ASK_USER_QUESTION_TOOL_NAME } from "../src/ask-user-question-tool.js";

type Authorize = (toolName: string, input: unknown) => PolicyOutcome;

const ctx = (authorizeToolUse?: Authorize): RunnerContext & { authorizeToolUse?: Authorize } =>
  ({
    config: { runtime: "claude-code", interaction: "interactive" },
    workspace: {
      repoId: "r",
      gitUrl: "https://github.com/skakel/skakel-test.git",
      repo: "r",
      baseBranch: "main",
      worktreePath: "/tmp/x",
      scratchPath: "/tmp/x/.dahrk/scratch",
    },
    ...(authorizeToolUse ? { authorizeToolUse } : {}),
  }) as RunnerContext & { authorizeToolUse?: Authorize };

// Arbitrary tools an interactive stage might call while an AskUserQuestion is outstanding.
const ARBITRARY = ["Bash", "Write", "Read", "Edit", ASK_USER_QUESTION_TOOL_NAME];

test("arbitrary tools run while an AskUserQuestion is present - none is denied", async () => {
  // No policy wired (ambient node): every tool is allowed, exactly as for a batch stage. The
  // AskUserQuestion shadow being registered changes nothing here - it never appears as a denial.
  for (const toolName of ARBITRARY) {
    const decision = await interactiveCanUseTool(false, STAGE_COMPLETE_TOOL_NAME, ctx(), toolName, {});
    assert.equal(decision.behavior, "allow", `${toolName} must be allowed`);
  }
});

test("allowedTools is an auto-approve list, not a whitelist: a tool outside it still runs", async () => {
  // "Bash" is neither the stage-complete exit nor the ask shadow (the only allowedTools entries), yet
  // it must still be allowed - proving the injected tools do not restrict the rest.
  const decision = await interactiveCanUseTool(false, STAGE_COMPLETE_TOOL_NAME, ctx(), "Bash", {
    command: "ls",
  });
  assert.equal(decision.behavior, "allow");
});

test("the edge policy remains the sole arbiter of denial (not the elicit seam)", async () => {
  const denyBash: Authorize = (toolName) =>
    toolName === "Bash"
      ? { verdict: "deny", policy: "demo_deny", reason: "sudo blocked" }
      : { verdict: "allow", policy: "demo_deny" };
  const denied = await interactiveCanUseTool(false, STAGE_COMPLETE_TOOL_NAME, ctx(denyBash), "Bash", {
    command: "sudo true",
  });
  assert.equal(denied.behavior, "deny");
  assert.equal((denied as { message: string }).message, "sudo blocked");
  // A non-denied tool still runs under the same policy.
  const allowed = await interactiveCanUseTool(false, STAGE_COMPLETE_TOOL_NAME, ctx(denyBash), "Write", {});
  assert.equal(allowed.behavior, "allow");
});

test("only the gate-exit summarisation turn denies - and only non-exit tools", async () => {
  // While summarising, arbitrary tools are denied so the model produces prose, not fresh stage work...
  const bash = await interactiveCanUseTool(true, STAGE_COMPLETE_TOOL_NAME, ctx(), "Bash", {});
  assert.equal(bash.behavior, "deny");
  // ...but the stage-complete exit tool is still permitted so the stage can settle.
  const exit = await interactiveCanUseTool(true, STAGE_COMPLETE_TOOL_NAME, ctx(), STAGE_COMPLETE_TOOL_NAME, {});
  assert.equal(exit.behavior, "allow");
});
