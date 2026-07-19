/**
 * Claude adapter MCP-config builder: brokered servers point at the node gateway proxy, not
 * the real upstream, so the agent only ever talks to localhost.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerContext } from "@dahrk/contracts";
import { buildBrokeredMcpServers } from "../src/claude-adapter.js";

const ctx = (over: Partial<RunnerContext> & { config?: Partial<RunnerContext["config"]> }): RunnerContext =>
  ({
    config: { runtime: "claude-code", interaction: "batch", ...over.config },
    workspace: {
      repoId: "r",
      gitUrl: "https://github.com/skakel/skakel-test.git",
      repo: "r",
      baseBranch: "main",
      worktreePath: "/tmp/x",
      scratchPath: "/tmp/x/.dahrk/scratch",
    },
    ...over,
  }) as RunnerContext;

test("brokered servers are routed through the proxy base url", () => {
  const result = buildBrokeredMcpServers(
    ctx({
      mcpProxyBaseUrl: "http://127.0.0.1:54321",
      config: {
        runtime: "claude-code",
        interaction: "batch",
        mcpServers: [
          { id: "linear", type: "http", url: "https://mcp.linear.app/mcp", credentialRef: "mcp-linear" },
        ],
      },
    }),
  );
  assert.deepEqual(result, { linear: { type: "http", url: "http://127.0.0.1:54321/linear" } });
});

test("no proxy url or no declared servers -> undefined (repo .mcp.json untouched)", () => {
  assert.equal(
    buildBrokeredMcpServers(
      ctx({ config: { mcpServers: [{ id: "x", type: "http", url: "u" }] } }), // no proxy url
    ),
    undefined,
  );
  assert.equal(buildBrokeredMcpServers(ctx({ mcpProxyBaseUrl: "http://127.0.0.1:1" })), undefined);
});
