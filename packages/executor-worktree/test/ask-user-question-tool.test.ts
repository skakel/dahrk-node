/**
 * The AskUserQuestion shadow tool (DHK-344): option mapping and the alias/name constants that wire it
 * into the Claude adapter's `toolAliases`. The blocking/answer behaviour lives in the elicit router
 * (see elicit-router.test.ts); here we cover the pure question -> ElicitQuestion mapping.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  toElicitQuestion,
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
