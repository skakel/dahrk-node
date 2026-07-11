/**
 * The `ask_user_question` shadow tool (DHK-344), the edge companion to DHK-223.
 *
 * The Claude Agent SDK's built-in `AskUserQuestion` is redirected to this in-process MCP tool via
 * `Options.toolAliases`, so an interactive-stage agent's structured question is surfaced as a Linear
 * `select` elicitation (through the edge `elicit` wire frame) instead of resolving to the headless
 * default "The user did not answer the questions." The tool still EXECUTES: this is mapping, not
 * gating (no tool is denied, per DHK-223).
 *
 * The blocking/concurrency logic lives in the adapter's `ask` callback (it owns the turn dispatcher,
 * the abort signal, and the idle windows). This module is the thin schema + option-mapping wrapper,
 * mirroring stage-complete-tool.ts.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ElicitChoice, ElicitQuestion } from "@dahrk/contracts";
import { z } from "zod";

/** The fully-qualified tool name the SDK exposes for the in-process `ask` MCP server, and the
 *  alias target the built-in `AskUserQuestion` is redirected to. */
export const ASK_USER_QUESTION_TOOL_NAME = "mcp__ask__ask_user_question";
/** The built-in SDK tool this shadow replaces (the `toolAliases` key). */
export const ASK_USER_QUESTION_ALIAS = "AskUserQuestion";

export interface AskUserQuestionTool {
  /** The in-process MCP server to pass to `query()`'s `mcpServers.ask`. */
  server: ReturnType<typeof createSdkMcpServer>;
  /** The allowed tool name to auto-approve (`mcp__ask__ask_user_question`). */
  allowedToolName: string;
}

/** One option as the built-in `AskUserQuestion` presents it: a display `label`, a `description`, and
 *  an optional `preview`. There is no separate machine value, so the label doubles as the fed-back
 *  value. Bounds are kept permissive so a slightly-off input never hard-fails the tool call. */
const optionSchema = z.object({
  label: z.string(),
  description: z.string().optional().default(""),
  preview: z.string().optional(),
});
const questionSchema = z.object({
  question: z.string(),
  header: z.string().optional().default(""),
  options: z.array(optionSchema).min(1),
  multiSelect: z.boolean().optional(),
});

/**
 * Fold one `AskUserQuestion` question into the shared `ElicitQuestion` shape. The human-readable
 * prompt carries the question plus each option's description (an `ElicitChoice` has no description
 * field), and options map `label -> { label, value: label }`.
 */
export function toElicitQuestion(q: {
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}): ElicitQuestion {
  const options: ElicitChoice[] = q.options.map((o) => ({ label: o.label, value: o.label }));
  const described = q.options.filter((o) => (o.description ?? "").trim());
  const lines = described.map((o) => `- ${o.label}: ${(o.description ?? "").trim()}`);
  const prompt = lines.length ? `${q.question}\n\n${lines.join("\n")}` : q.question;
  return { prompt, options, ...(q.multiSelect ? { multiSelect: true } : {}) };
}

/**
 * Build the `ElicitQuestion` to surface for a batch of questions from one tool call. v1 surfaces
 * only the first; when >1 arrive together the degrade note is folded into the prompt so the human
 * knows more are pending (DHK-223 D5 degrade philosophy: no denial, no forced retry loop).
 */
export function buildElicitFromQuestions(
  questions: { question: string; options: { label: string; description?: string }[]; multiSelect?: boolean }[],
): ElicitQuestion {
  const first = questions[0]!;
  const q = toElicitQuestion(first);
  const prompt =
    questions.length > 1
      ? `${q.prompt}\n\n(Note: ${questions.length} questions were asked at once; answer this one first, then ask the rest.)`
      : q.prompt;
  return { ...q, prompt };
}

export function createAskUserQuestionTool(deps: {
  /** Surface the question as a Linear elicitation and block until the human replies. Returns the
   *  text handed back to the model (the selected value, or a soft note on no-reply / one-at-a-time). */
  ask: (question: ElicitQuestion) => Promise<string>;
}): AskUserQuestionTool {
  const askTool = tool(
    "ask_user_question",
    "Ask the human a structured multiple-choice question and wait for their selection. Use this " +
      "when you need the human to choose between options before you can continue.",
    { questions: z.array(questionSchema).min(1) },
    async (args) => {
      const text = await deps.ask(buildElicitFromQuestions(args.questions));
      return { content: [{ type: "text", text }] };
    },
  );
  return {
    server: createSdkMcpServer({ name: "ask", version: "0.0.0", tools: [askTool] }),
    allowedToolName: ASK_USER_QUESTION_TOOL_NAME,
  };
}
