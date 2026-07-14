/**
 * Codex cost known-unknown (DHK-434). The Codex SDK's `Usage` is token-only - it carries no price
 * field - so the adapter genuinely cannot report a dollar cost. The honest fix is to leave
 * `JobResult.costUsd` unset (never a fabricated `$0`, which the hub cannot tell from "free" and which
 * silently disables the `cost_budget` policy) AND to state the gap explicitly, in the same stderr
 * channel the adapter uses for its other runtime known-unknowns (MCP, interactive tool-exit).
 *
 * The full `runBatch` path opens a live Codex thread (the SDK is not installed here, matching the
 * repo's testing philosophy for this adapter - see codex-runtime-env.test.ts), so this pins the pure
 * signal helper the adapter calls once per run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CODEX_COST_UNAVAILABLE_NOTE, warnCostUnavailable } from "../src/codex-adapter.js";

test("warnCostUnavailable surfaces an explicit cost-unavailable signal", () => {
  const written: string[] = [];
  warnCostUnavailable((s) => written.push(s));
  assert.equal(written.length, 1, "the note is emitted exactly once");
  assert.equal(written[0], CODEX_COST_UNAVAILABLE_NOTE);
});

test("the note names the runtime and distinguishes 'unavailable' from a $0 / free cost", () => {
  assert.match(CODEX_COST_UNAVAILABLE_NOTE, /codex/i);
  assert.match(CODEX_COST_UNAVAILABLE_NOTE, /unavailable/i);
  // The whole point: a $0-costing Codex stage must read as "not priced", not "cost nothing".
  assert.match(CODEX_COST_UNAVAILABLE_NOTE, /not \$0/i);
});

test("the signal carries no fabricated dollar figure", () => {
  // Any bare price like `$0.12` would be a fabrication; only the literal `$0` (as the thing we are
  // NOT reporting) may appear.
  const prices = CODEX_COST_UNAVAILABLE_NOTE.match(/\$\d+(?:\.\d+)?/g) ?? [];
  assert.deepEqual(prices, ["$0"], "the note asserts it is not $0 and invents no other price");
});
