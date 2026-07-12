/**
 * The AskUserQuestion shadow tool (DHK-344): option mapping and the alias/name constants that wire it
 * into the Claude adapter's `toolAliases`. The blocking/answer behaviour lives in the elicit router
 * (see elicit-router.test.ts); here we cover the pure question -> ElicitQuestion mapping.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ElicitQuestion } from "@dahrk/contracts";
import {
  toElicitQuestion,
  askQuestionsSequentially,
  createAskUserQuestionTool,
  ASK_USER_QUESTION_TOOL_NAME,
  ASK_USER_QUESTION_ALIAS,
} from "../src/ask-user-question-tool.js";

test("options map label -> {label, value:label} and descriptions fold into the prompt", () => {
  const q = toElicitQuestion({
    question: "Which approach?",
    options: [
      { label: "MVP", description: "ship the thin slice first" },
      { label: "Full", description: "build the whole thing" },
    ],
  });
  assert.deepEqual(q.options, [
    { label: "MVP", value: "MVP" },
    { label: "Full", value: "Full" },
  ]);
  assert.equal(
    q.prompt,
    "Which approach?\n\n- MVP: ship the thin slice first\n- Full: build the whole thing",
  );
  assert.equal(q.multiSelect, undefined);
});

test("a question with no descriptions carries just the question text", () => {
  const q = toElicitQuestion({
    question: "Pick one",
    options: [
      { label: "A", description: "" },
      { label: "B" },
    ],
  });
  assert.equal(q.prompt, "Pick one");
  assert.deepEqual(q.options, [
    { label: "A", value: "A" },
    { label: "B", value: "B" },
  ]);
});

test("multiSelect is carried through", () => {
  const q = toElicitQuestion({
    question: "Choose any",
    options: [
      { label: "X", description: "" },
      { label: "Y", description: "" },
    ],
    multiSelect: true,
  });
  assert.equal(q.multiSelect, true);
});

test("the alias constants wire AskUserQuestion to the shadow tool name", () => {
  assert.equal(ASK_USER_QUESTION_ALIAS, "AskUserQuestion");
  assert.equal(ASK_USER_QUESTION_TOOL_NAME, "mcp__ask__ask_user_question");
});

test("createAskUserQuestionTool exposes the server and the auto-approve tool name", () => {
  const built = createAskUserQuestionTool({ ask: async () => "The user selected: A" });
  assert.equal(built.allowedToolName, ASK_USER_QUESTION_TOOL_NAME);
  assert.ok(built.server, "an in-process MCP server is created for the shadow tool");
});

test("askQuestionsSequentially: a single question returns its answer verbatim, no degrade note", async () => {
  const raised: ElicitQuestion[] = [];
  const text = await askQuestionsSequentially(
    [{ question: "Deploy now?", options: [{ label: "Yes" }, { label: "No" }] }],
    async (q) => {
      raised.push(q);
      return "The user selected: Yes";
    },
  );
  assert.equal(raised.length, 1, "one question raised");
  assert.equal(raised[0]!.prompt, "Deploy now?");
  assert.ok(!text.includes("Note:"), "no degrade note");
  assert.equal(text, "The user selected: Yes");
});

// DHK-406: every question in a >1 batch must reach the human; none silently discarded.
test("askQuestionsSequentially: >1 questions each surface (in order); no tail is dropped", async () => {
  const raised: ElicitQuestion[] = [];
  const text = await askQuestionsSequentially(
    [
      { question: "First?", options: [{ label: "A" }, { label: "B" }] },
      { question: "Second?", options: [{ label: "C" }, { label: "D" }] },
    ],
    async (q) => {
      raised.push(q);
      return `The user selected: ${q.options[0]!.label}`;
    },
  );
  // Both questions were raised, in order — not just the first.
  assert.equal(raised.length, 2, "both questions raised");
  assert.equal(raised[0]!.prompt, "First?");
  assert.deepEqual(raised[0]!.options, [
    { label: "A", value: "A" },
    { label: "B", value: "B" },
  ]);
  // The second question keeps its own options (C/D) — the DHK-406 regression: these used to vanish.
  assert.equal(raised[1]!.prompt, "Second?");
  assert.deepEqual(raised[1]!.options, [
    { label: "C", value: "C" },
    { label: "D", value: "D" },
  ]);
  // No prose "ask the rest later" note is emitted on any question.
  assert.ok(!raised.some((q) => q.prompt.includes("questions were asked at once")), "no degrade note");
  // The returned text reflects both answers, each tied back to its question.
  assert.ok(text.includes("Q1 (First?): The user selected: A"), "first answer labelled");
  assert.ok(text.includes("Q2 (Second?): The user selected: C"), "second answer labelled");
});

// DHK-406 stage-kill hazard (dahrk-node half): a mid-interview reply whose prose contains "deny"
// must be surfaced as the answer to its question, never swallowed or reinterpreted. The gate-scan
// cancel path itself lives in dahrk-harness; here we pin that the tool relays such text intact.
test("askQuestionsSequentially: a reply containing 'deny' is relayed as the answer, not dropped", async () => {
  const text = await askQuestionsSequentially(
    [
      { question: "Split writes?", options: [{ label: "Owner" }, { label: "Admin" }] },
      { question: "Bypass requireRole?", options: [{ label: "Deny member write" }, { label: "Allow" }] },
    ],
    async (q) => `The user selected: ${q.options[0]!.label}`,
  );
  assert.ok(text.includes("Q2 (Bypass requireRole?): The user selected: Deny member write"));
});
