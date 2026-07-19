/**
 * The mock runner's interactive drive (M5b): it consumes the turns AsyncIterable, emits a
 * thought + response per turn, and exits via the __complete__ sentinel (tool), the stream
 * ending (gate), or cancel (fail). This is what lets the hub harness drive an interactive
 * stage hermetically.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { HumanTurn, RunnerContext, TraceEvent, WorkspaceRef } from "@dahrk/contracts";
import { createMockRunner } from "../src/mock-runner.js";
import { ManagedMailbox } from "../src/runner-shared.js";

const ws: WorkspaceRef = { repoId: "r", gitUrl: "https://example.invalid/r.git", repo: "r", baseBranch: "main", worktreePath: "/tmp/r", scratchPath: "/tmp/r/.dahrk" };
const ctx: RunnerContext = { config: { runtime: "claude-code", interaction: "interactive" }, workspace: ws };
const turn = (text: string): HumanTurn => ({ text, ts: "2026-06-21T00:00:00Z" });

test("gate exit: consumes turns then ends when the stream closes", async () => {
  const runner = createMockRunner("claude-code");
  const mb = new ManagedMailbox<HumanTurn>();
  const events: TraceEvent[] = [];
  const p = runner.runInteractive(ctx, mb, (e) => events.push(e));
  mb.push(turn("first"));
  mb.push(turn("second"));
  mb.end();
  const res = await p;
  assert.equal(res.status, "ok");
  assert.match(res.summary, /gate/);
  assert.match(res.summary, /2 turns/);
  // A thought + response per turn.
  assert.equal(events.filter((e) => e.type === "thought").length, 2);
  assert.equal(events.filter((e) => e.type === "response").length, 2);
  assert.ok(events.some((e) => e.type === "thought" && e.text?.includes("first")));
});

test("tool exit: the __complete__ sentinel ends the stage like dahrk_stage_complete", async () => {
  const runner = createMockRunner("claude-code");
  const mb = new ManagedMailbox<HumanTurn>();
  const events: TraceEvent[] = [];
  const p = runner.runInteractive(ctx, mb, (e) => events.push(e));
  mb.push(turn("only turn"));
  mb.push(turn("__complete__"));
  const res = await p;
  assert.equal(res.status, "ok");
  assert.match(res.summary, /tool/);
  // The sentinel is not echoed as a turn.
  assert.equal(events.filter((e) => e.type === "thought").length, 1);
});

test("cancel: ending the mailbox after cancel yields a failed stage", async () => {
  const runner = createMockRunner("claude-code");
  const mb = new ManagedMailbox<HumanTurn>();
  const p = runner.runInteractive(ctx, mb, () => {});
  mb.push(turn("hi"));
  await runner.cancel();
  mb.end();
  const res = await p;
  assert.equal(res.status, "fail");
});
