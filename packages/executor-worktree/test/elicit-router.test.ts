/**
 * The elicit turn router (DHK-344): fans one relayed human-turn stream out into conversational turns
 * and a blocking `ask` that an injected AskUserQuestion shadow tool awaits. SDK-free, so the routing,
 * blocking, deadline, abort, one-at-a-time and stream-end behaviours are exercised without a model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { HumanTurn } from "@dahrk/contracts";
import { ManagedMailbox, createElicitTurnRouter } from "../src/runner-shared.js";

const turn = (text: string): HumanTurn => ({ text, ts: "2026-07-10T00:00:00.000Z" });
const windows = { firstReplyMs: 10_000, idleMs: 10_000 };

test("a relayed turn resolves a blocked elicit with the selected value", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  const ctrl = new AbortController();
  const router = createElicitTurnRouter(turns, { signal: ctrl.signal, ...windows });

  let raised = 0;
  const p = router.ask(false, () => void raised++);
  turns.push(turn("Option B"));
  assert.deepEqual(await p, { kind: "reply", text: "Option B" });
  assert.equal(raised, 1, "onRaise fired exactly once for the raised elicit");
});

test("a turn with no elicit in flight flows to the conversation stream", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  const ctrl = new AbortController();
  const router = createElicitTurnRouter(turns, { signal: ctrl.signal, ...windows });

  const conv = router.conversation[Symbol.asyncIterator]();
  turns.push(turn("just chatting"));
  const first = await conv.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.text, "just chatting");
});

test("a second concurrent ask returns busy without raising", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  const ctrl = new AbortController();
  const router = createElicitTurnRouter(turns, { signal: ctrl.signal, ...windows });

  let raised = 0;
  const first = router.ask(false, () => void raised++);
  const second = await router.ask(false, () => void raised++);
  assert.deepEqual(second, { kind: "busy" });
  assert.equal(raised, 1, "the busy call did not raise a second elicit");

  // The reply resolves the first (still-outstanding) elicit, not the busy one.
  turns.push(turn("A"));
  assert.deepEqual(await first, { kind: "reply", text: "A" });
});

test("the idle deadline resolves a blocked elicit as noreply", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  const ctrl = new AbortController();
  const router = createElicitTurnRouter(turns, { signal: ctrl.signal, firstReplyMs: 20, idleMs: 20 });
  assert.deepEqual(await router.ask(false, () => {}), { kind: "noreply" });
});

test("firstReply selects the opening-reply budget over the idle window", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  const ctrl = new AbortController();
  // A tiny idle window but a large first-reply window: firstReply=true must NOT time out on idleMs.
  const router = createElicitTurnRouter(turns, { signal: ctrl.signal, firstReplyMs: 10_000, idleMs: 15 });
  const p = router.ask(true, () => {});
  turns.push(turn("answered in time"));
  assert.deepEqual(await p, { kind: "reply", text: "answered in time" });
});

test("abort resolves a blocked elicit as cancel", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  const ctrl = new AbortController();
  const router = createElicitTurnRouter(turns, { signal: ctrl.signal, ...windows });
  const p = router.ask(false, () => {});
  ctrl.abort();
  assert.deepEqual(await p, { kind: "cancel" });
});

test("the turn stream ending cancels a still-blocked elicit and ends the conversation", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  const ctrl = new AbortController();
  const router = createElicitTurnRouter(turns, { signal: ctrl.signal, ...windows });
  const conv = router.conversation[Symbol.asyncIterator]();
  const p = router.ask(false, () => {});
  turns.end();
  assert.deepEqual(await p, { kind: "cancel" });
  assert.equal((await conv.next()).done, true);
});

test("asks after a reply reuse the router (sequential questions)", async () => {
  const turns = new ManagedMailbox<HumanTurn>();
  const ctrl = new AbortController();
  const router = createElicitTurnRouter(turns, { signal: ctrl.signal, ...windows });

  const p1 = router.ask(false, () => {});
  turns.push(turn("first"));
  assert.deepEqual(await p1, { kind: "reply", text: "first" });

  const p2 = router.ask(false, () => {});
  turns.push(turn("second"));
  assert.deepEqual(await p2, { kind: "reply", text: "second" });
});
