/**
 * The `dahrk_stage_complete` tool, injected per interactive stage as an in-process
 * Claude MCP tool (the per-stage exception to the otherwise-gated tool set). When the
 * agent calls it, the stage ends and its `summary` argument becomes the handoff summary.
 * Ported from the S2 spike's tool definition + captured-summary closure.
 *
 * An interactive stage cannot write files (the tool set is gated to this one tool), so the
 * optional `document` argument is the sanctioned channel for it to hand back a deliverable
 * (e.g. a spec) that a later `attach-document` action publishes to Linear - no filesystem
 * path for the model to get wrong. See the edge stage-runner's artifact resolution chain.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/** The fully-qualified tool name the SDK exposes for the in-process `skakel` MCP server. */
export const STAGE_COMPLETE_TOOL_NAME = "mcp__dahrk__dahrk_stage_complete";

export interface StageCompleteTool {
  /** The in-process MCP server to pass to `query()`'s `mcpServers.dahrk`. */
  server: ReturnType<typeof createSdkMcpServer>;
  /** The allowed tool name to whitelist (`mcp__dahrk__dahrk_stage_complete`). */
  allowedToolName: string;
  /** True once the agent has called the tool. */
  fired(): boolean;
  /** The captured one-sentence summary, or null if the tool has not fired. */
  summary(): string | null;
  /** The captured deliverable document body, or null if none was handed back. */
  document(): string | null;
  /** Invoke the capture directly, exactly as the SDK's MCP handler does - the seam a
   *  `FakeClaudeSession` uses to drive a stage-complete exit without running the live SDK. */
  capture(args: { summary: string; document?: string }): void;
}

export function createStageCompleteTool(): StageCompleteTool {
  let captured: string | null = null;
  let capturedDoc: string | null = null;
  // The capture body the SDK's MCP handler runs; extracted so a `FakeClaudeSession` can drive the
  // tool-exit path without the live SDK. Production still fires via the handler below, unchanged.
  const capture = (args: { summary: string; document?: string }): void => {
    captured = args.summary;
    if (args.document !== undefined) capturedDoc = args.document;
  };
  const completeTool = tool(
    "dahrk_stage_complete",
    "End the current stage and hand off a one-sentence summary of what was accomplished. When the " +
      "stage's deliverable is a document (e.g. a specification or report) to be published, pass its " +
      "full markdown body as `document`; this is the only way an interactive stage can emit a " +
      "document, since it cannot write files.",
    {
      summary: z.string().describe("A one-sentence summary of the stage outcome."),
      document: z
        .string()
        .optional()
        .describe("The full markdown body of the stage's deliverable document, if any."),
    },
    async (args) => {
      capture(args);
      return { content: [{ type: "text", text: "Stage marked complete." }] };
    },
  );
  return {
    server: createSdkMcpServer({ name: "dahrk", version: "0.0.0", tools: [completeTool] }),
    allowedToolName: STAGE_COMPLETE_TOOL_NAME,
    fired: () => captured !== null,
    summary: () => captured,
    document: () => capturedDoc,
    capture,
  };
}
