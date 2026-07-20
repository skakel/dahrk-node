/**
 * The shared CYPACK-1177 settle decision (response-rule.ts), the one home for "the response is the last
 * assistant text, never a tool-ended turn's body". Both mappers fold their own (divergent) accumulators
 * and then defer the decision here; these pin every veto and the trimming so the rule cannot drift.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideResponse } from "../src/response-rule.js";

test("ok, non-empty text, not tool-ended: the text is the response and yields a response event", () => {
  const d = decideResponse("All three tests pass.", false, "ok");
  assert.equal(d.responseText, "All three tests pass.");
  assert.deepEqual(d.event, { type: "response", text: "All three tests pass." });
});

test("veto - tool-ended turn: intermediate/tool-input text is never the response", () => {
  const d = decideResponse("Calling the tool now.", true, "ok");
  assert.equal(d.responseText, undefined);
  assert.equal(d.event, undefined);
});

test("veto - empty / whitespace-only text: no response", () => {
  assert.deepEqual(decideResponse("", false, "ok"), {});
  assert.deepEqual(decideResponse("   \n\t ", false, "ok"), {});
});

test("veto - non-ok settle status: a failed turn posts no response", () => {
  assert.deepEqual(decideResponse("half-written answer", false, "fail"), {});
  assert.deepEqual(decideResponse("half-written answer", false, "timeout"), {});
});

test("the response text is trimmed (Pi accumulates raw deltas; Claude trims on capture - settled identically here)", () => {
  const d = decideResponse("  final answer  ", false, "ok");
  assert.equal(d.responseText, "final answer");
  assert.deepEqual(d.event, { type: "response", text: "final answer" });
});
