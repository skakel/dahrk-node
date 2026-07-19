/**
 * Brokered MCP end-to-end for the Pi runtime (DHK-507): the REAL node gateway + the REAL Pi extension
 * bridge, proving a Pi stage can call a brokered MCP tool with the raw secret never reaching the agent.
 *
 * This is the only package that can wire both halves: `@dahrk/edge` owns `startMcpGateway`, and it
 * depends on `@dahrk/executor-worktree` for the Pi extension (`buildBrokeredPiMcpServers` +
 * `createBrokeredMcpExtension`). executor-worktree cannot import edge, so the pure builder + the
 * extension-against-a-direct-stub live there; the real-gateway + no-leak assertion lives here.
 *
 * Topology: Pi extension (MCP client) -> node gateway proxy (holds the token) -> stub MCP server.
 * The token is handed ONLY to the gateway's `creds`; the agent-facing config is the localhost proxy
 * url. The stub records the inbound Authorization header to prove the proxy - not the agent - added it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { McpServerRef, RunnerContext } from "@dahrk/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildBrokeredPiMcpServers, createBrokeredMcpExtension } from "@dahrk/executor-worktree";
import { startMcpGateway } from "../src/mcp-gateway.js";

/**
 * A stub MCP server (real SDK, stateless Streamable HTTP) exposing an `echo` tool. Every inbound POST's
 * Authorization header is recorded, so the test can prove the token arrived from the gateway proxy.
 */
async function startStubMcpServer(): Promise<{ url: string; seenAuth: string[]; stop: () => Promise<void> }> {
  const seenAuth: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    seenAuth.push(req.headers.authorization ?? "<none>");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close());
    const mcp = new McpServer({ name: "stub", version: "0.0.1" });
    mcp.registerTool(
      "echo",
      { description: "Echo the input text back", inputSchema: { text: z.string() } },
      async (args: { text: string }) => ({ content: [{ type: "text", text: `echo:${args.text}` }] }),
    );
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenAuth,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Captures every tool the Pi extension registers, with full metadata (so we can scan it for leaks). */
type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: unknown) => Promise<{ content: unknown }>;
};
function fakePi(): { registerTool: (t: RegisteredTool) => void; tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>();
  return { tools, registerTool: (t) => tools.set(t.name, t) };
}

test("a Pi tool call routes through the real gateway to the brokered server and returns its result", async () => {
  const TOKEN = "s3cr3t-broker-token-DHK507";
  const stub = await startStubMcpServer();
  const mcpServers: McpServerRef[] = [{ id: "linear", type: "http", url: stub.url, credentialRef: "mcp-linear" }];
  const gateway = await startMcpGateway({ servers: mcpServers, creds: { linear: TOKEN } });
  try {
    // Build the Pi wiring exactly as `defaultCreatePiSession` does in production.
    const servers = buildBrokeredPiMcpServers({
      config: { mcpServers } as RunnerContext["config"],
      mcpProxyBaseUrl: gateway.baseUrl,
    } as RunnerContext);
    assert.ok(servers, "the builder produced a brokered-server map");

    const pi = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createBrokeredMcpExtension(servers!).factory(pi as any);

    // AC1: the Pi agent successfully calls a brokered tool - the call round-trips to the stub.
    const echo = pi.tools.get("echo");
    assert.ok(echo, "the brokered server's `echo` tool is registered as a Pi tool");
    const result = (await echo!.execute("call-1", { text: "hi" })) as { content: { type: string; text: string }[] };
    assert.deepEqual(result.content, [{ type: "text", text: "echo:hi" }]);

    // AC2 (upstream): the stub saw `Authorization: Bearer <token>` on every request - the proxy injected
    // it. Never `<none>`: the gateway authenticates every forwarded call.
    assert.ok(stub.seenAuth.length > 0, "the stub received forwarded requests");
    for (const auth of stub.seenAuth) assert.equal(auth, `Bearer ${TOKEN}`, "every upstream request carried the injected bearer");

    // AC2 (agent side): the agent-facing url is the localhost proxy, and the raw token appears NOWHERE
    // in the config handed to the extension nor in any registered tool's metadata.
    assert.equal(servers!.linear.url, `${gateway.baseUrl}/linear`);
    assert.match(servers!.linear.url, /^http:\/\/127\.0\.0\.1:\d+\/linear$/);
    assert.ok(!JSON.stringify(servers).includes(TOKEN), "the brokered-server config never carries the raw token");
    const registeredMeta = [...pi.tools.values()].map(({ name, label, description, parameters }) => ({ name, label, description, parameters }));
    assert.ok(!JSON.stringify(registeredMeta).includes(TOKEN), "no registered Pi tool's metadata carries the raw token");
  } finally {
    await gateway.stop();
    await stub.stop();
  }
});
