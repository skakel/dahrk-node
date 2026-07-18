/**
 * overlay tests: materialise pinned components into the worktree `.claude/` with repo-local
 * precedence (Claude), warn-and-skip for non-Claude runtimes (Codex, Pi), and idempotency on re-dispatch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ComponentRef } from "@dahrk/contracts";
import { createPackCache, type ComponentBytes, type PackSource } from "../src/pack-cache.js";
import { overlayComponents } from "../src/overlay.js";

const sha = (s: string): string => createHash("sha256").update(Buffer.from(s)).digest("hex");

function component(kind: ComponentRef["kind"], name: string, path: string, body: string): { ref: ComponentRef; bytes: ComponentBytes } {
  const fileSha = sha(body);
  const combined = createHash("sha256");
  combined.update(path);
  combined.update("\0");
  combined.update(fileSha);
  combined.update("\0");
  return {
    ref: { kind, name, version: "1.0.0", contentHash: `sha256:${combined.digest("hex")}` },
    bytes: { files: [{ path, bytes: Buffer.from(body), sha256: fileSha }] },
  };
}

function fixtureCache(...comps: { ref: ComponentRef; bytes: ComponentBytes }[]) {
  const map: Record<string, ComponentBytes> = {};
  for (const c of comps) map[c.ref.contentHash] = c.bytes;
  const source: PackSource = {
    async fetch(ref) {
      const b = map[ref.contentHash];
      if (!b) throw new Error(`no fixture for ${ref.contentHash}`);
      return b;
    },
  };
  const root = mkdtempSync(join(tmpdir(), "dahrk-cas-"));
  return createPackCache({ root, source });
}

test("Claude writes skill/command/agent files into the right .claude/ subdirs", async () => {
  const skill = component("skill", "review", ".claude/skills/review/SKILL.md", "review skill");
  const command = component("command", "ship", ".claude/commands/ship.md", "ship command");
  const agent = component("agent", "critic", ".claude/agents/critic.md", "critic agent");
  const cache = fixtureCache(skill, command, agent);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const res = await overlayComponents({
    worktreePath: worktree,
    runtime: "claude-code",
    components: [skill.ref, command.ref, agent.ref],
    cache,
  });

  assert.deepEqual(res.written.sort(), [
    ".claude/agents/critic.md",
    ".claude/commands/ship.md",
    ".claude/skills/review/SKILL.md",
  ]);
  assert.equal(res.skippedRepoLocal.length, 0);
  assert.equal(res.warnings.length, 0);
  assert.equal(readFileSync(join(worktree, ".claude/skills/review/SKILL.md"), "utf8"), "review skill");
});

test("a repo file at the same path is preserved (repo-local precedence) and reported", async () => {
  const skill = component("skill", "review", ".claude/skills/review/SKILL.md", "central skill");
  const cache = fixtureCache(skill);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));
  const dest = join(worktree, ".claude/skills/review/SKILL.md");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, "repo skill");

  const res = await overlayComponents({
    worktreePath: worktree,
    runtime: "claude-code",
    components: [skill.ref],
    cache,
  });

  assert.deepEqual(res.skippedRepoLocal, [".claude/skills/review/SKILL.md"]);
  assert.equal(res.written.length, 0);
  assert.equal(readFileSync(dest, "utf8"), "repo skill", "the repo's file must not be clobbered");
});

test("Codex warns and writes nothing", async () => {
  const skill = component("skill", "review", ".claude/skills/review/SKILL.md", "central skill");
  const cache = fixtureCache(skill);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const res = await overlayComponents({
    worktreePath: worktree,
    runtime: "codex",
    components: [skill.ref],
    cache,
  });

  assert.equal(res.written.length, 0);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0]!, /codex runtime/);
  assert.equal(existsSync(join(worktree, ".claude/skills/review/SKILL.md")), false);
});

test("Pi warns and writes nothing (no .claude/ surface)", async () => {
  const skill = component("skill", "review", ".claude/skills/review/SKILL.md", "central skill");
  const cache = fixtureCache(skill);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const res = await overlayComponents({
    worktreePath: worktree,
    runtime: "pi",
    components: [skill.ref],
    cache,
  });

  assert.equal(res.written.length, 0);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0]!, /pi runtime/);
  assert.match(res.warnings[0]!, /review/);
  assert.equal(existsSync(join(worktree, ".claude/skills/review/SKILL.md")), false);
});

test("a second overlay over identical bytes is idempotent (no clobber, no skip)", async () => {
  const skill = component("skill", "review", ".claude/skills/review/SKILL.md", "central skill");
  const cache = fixtureCache(skill);
  const worktree = mkdtempSync(join(tmpdir(), "dahrk-wt-"));

  const first = await overlayComponents({ worktreePath: worktree, runtime: "claude-code", components: [skill.ref], cache });
  assert.deepEqual(first.written, [".claude/skills/review/SKILL.md"]);

  const second = await overlayComponents({ worktreePath: worktree, runtime: "claude-code", components: [skill.ref], cache });
  assert.equal(second.written.length, 0, "an identical re-overlay writes nothing");
  assert.equal(second.skippedRepoLocal.length, 0, "an identical re-overlay is not a repo-local skip");
});
