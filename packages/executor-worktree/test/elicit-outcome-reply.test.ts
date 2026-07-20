/**
 * The shared elicit outcome->text map (DHK-591): the single source of the exact tool-result strings
 * both the Pi and Claude adapters return for a reply/busy/noreply/cancel elicit outcome. Asserting the
 * four branches here pins the strings byte-identically so the adapters cannot drift apart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { elicitOutcomeReply } from "../src/elicit-router.js";

test("reply interpolates the selected text", () => {
  assert.equal(elicitOutcomeReply({ kind: "reply", text: "Option B" }), "The user selected: Option B");
});

test("busy returns the one-at-a-time note", () => {
  assert.equal(
    elicitOutcomeReply({ kind: "busy" }),
    "Only one question can be asked at a time; wait for the current one to be answered, then ask again.",
  );
});

test("noreply returns the proceed-with-best-judgement note", () => {
  assert.equal(
    elicitOutcomeReply({ kind: "noreply" }),
    "No response from the user; proceed with your best judgement.",
  );
});

test("cancel returns the cancelled note", () => {
  assert.equal(elicitOutcomeReply({ kind: "cancel" }), "The question was cancelled.");
});
