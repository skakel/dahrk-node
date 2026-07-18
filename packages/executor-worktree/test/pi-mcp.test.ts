/**
 * Pi adapter brokered-MCP wiring (DHK-507). Two units, both testable without a live Pi install:
 *  1. `buildBrokeredPiMcpServers` - the pure builder that points each declared server at the node
 *     gateway proxy (`${proxyBase}/<id>`), mirroring the Claude adapter's `buildBrokeredMcpServers`.
 *  2. `createBrokeredMcpExtension` - the inline Pi extension whose async factory connects an MCP
 *     client per server, lists its tools, and registers each as a Pi tool. Driven here against a
 *     REAL `@modelcontextprotocol/sdk` server over a direct URL (no gateway yet - the full
 *     real-gateway + no-leak path lives in `@dahrk/edge`, the only package that can import both).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { RunnerContext } from "@dahrk/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildBrokeredPiMcpServers, createBrokeredMcpExtension } from "../src/pi-adapter.js";

const ctx = (over: Partial<RunnerContext> & { config?: Partial<RunnerContext["config"]> }): RunnerContext =>
  ({
    config: { runtime: "pi", interaction: "batch", ...over.config },
    workspace: { worktreePath: "/tmp/wt", branch: "main" },
    ...over,
  }) as RunnerContext;

test("buildBrokeredPiMcpServers routes each declared server through the proxy base url", () => {
  const result = buildBrokeredPiMcpServers(
    ctx({
      mcpProxyBaseUrl: "http://127.0.0.1:54321",
      config: {
        runtime: "pi",
        interaction: "batch",
        mcpServers: [
          { id: "linear", type: "http", url: "https://mcp.linear.app/mcp", credentialRef: "mcp-linear" },
          { id: "gh", type: "sse", url: "https://mcp.github.com/sse" },
        ],
      },
    }),
  );
  assert.deepEqual(result, {
    linear: { type: "http", url: "http://127.0.0.1:54321/linear" },
    gh: { type: "sse", url: "http://127.0.0.1:54321/gh" },
  });
});

test("buildBrokeredPiMcpServers returns undefined with no declared servers", () => {
  assert.equal(buildBrokeredPiMcpServers(ctx({ mcpProxyBaseUrl: "http://127.0.0.1:1" })), undefined);
});

test("buildBrokeredPiMcpServers returns undefined when the proxy base url is absent", () => {
  assert.equal(
    buildBrokeredPiMcpServers(
      ctx({
        config: {
          runtime: "pi",
          interaction: "batch",
          mcpServers: [{ id: "linear", type: "http", url: "https://mcp.linear.app/mcp" }],
        },
      }),
    ),
    undefined,
  );
});

/**
 * Stand up a real MCP server (Streamable HTTP) exposing one `echo` tool, on an ephemeral localhost
 * port. Returns the base url and a stop(). The tool echoes its `text` argument so a round-trip is
 * observable end-to-end.
 */
async function startStubMcpServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  // Stateless Streamable-HTTP mode: a fresh transport + server per POST, JSON responses (no lingering
  // SSE stream). Matches the SDK's `jsonResponseStreamableHttp` example.
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
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
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A minimal fake of the Pi extension API: captures every registered tool. */
function fakePi(): {
  registerTool: (t: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) => void;
  tools: Map<string, { name: string; execute: (id: string, params: unknown) => Promise<unknown> }>;
} {
  const tools = new Map<string, { name: string; execute: (id: string, params: unknown) => Promise<unknown> }>();
  return { tools, registerTool: (t) => tools.set(t.name, t) };
}

test("createBrokeredMcpExtension registers the remote server's tools and round-trips a call", async () => {
  const stub = await startStubMcpServer();
  try {
    const ext = createBrokeredMcpExtension({ stub: { type: "http", url: stub.url } });
    const pi = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ext.factory(pi as any);

    const echo = pi.tools.get("echo");
    assert.ok(echo, "the remote `echo` tool is registered as a Pi tool");
    const result = (await echo!.execute("call-1", { text: "hi" })) as { content: { type: string; text: string }[] };
    assert.deepEqual(result.content, [{ type: "text", text: "echo:hi" }]);
  } finally {
    await stub.stop();
  }
});

test("createBrokeredMcpExtension isolates a failing server: healthy tools still register", async () => {
  const stub = await startStubMcpServer();
  try {
    const ext = createBrokeredMcpExtension({
      dead: { type: "http", url: "http://127.0.0.1:1/mcp" }, // nothing listening
      stub: { type: "http", url: stub.url },
    });
    const pi = fakePi();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ext.factory(pi as any); // must resolve despite the dead server
    assert.ok(pi.tools.has("echo"), "the healthy server's tool registered even though a sibling failed");
  } finally {
    await stub.stop();
  }
});
