/**
 * `resolveStageArtifact` finds a stage's deliverable document from whichever channel produced
 * content, so `attach-document` publishes it however the prompt author produced it. Precedence:
 * declared `emitArtifact` file -> document handed back via `dahrk_stage_complete` -> scratch/output
 * scan -> any changed markdown. Interactive stages now have full tool parity, so they may write the
 * declared file directly (declared-file wins) OR hand it back via the tool when they wrote no file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceRef } from "@dahrk/contracts";
import { resolveStageArtifact } from "../src/stage-runner.js";

const withWorktree = (fn: (ref: WorkspaceRef, dir: string) => void, initGit = false): void => {
  const dir = mkdtempSync(join(tmpdir(), "artifact-resolve-"));
  try {
    if (initGit) {
      const git = (...a: string[]): void => void execFileSync("git", a, { cwd: dir, stdio: "ignore" });
      git("init", "-b", "main");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "T");
      writeFileSync(join(dir, "README.md"), "hello\n");
      git("add", ".");
      git("commit", "-m", "init");
    }
    fn({ worktreePath: dir } as WorkspaceRef, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("declared emitArtifact file wins when present", () => {
  withWorktree((ref, dir) => {
    mkdirSync(join(dir, ".dahrk/scratch/output"), { recursive: true });
    writeFileSync(join(dir, ".dahrk/scratch/output/spec.md"), "# Spec\nfrom file\n");
    const r = resolveStageArtifact(ref, ".dahrk/scratch/output/spec.md", undefined);
    assert.equal(r?.source, "declared-file");
    assert.match(r?.artifact.content ?? "", /from file/);
    assert.equal(r?.artifact.path, ".dahrk/scratch/output/spec.md");
  });
});

test("a document handed back via the tool is used when the stage wrote no file", () => {
  withWorktree((ref) => {
    // No declared file exists (the stage wrote none) -> the handoff wins.
    const r = resolveStageArtifact(ref, ".dahrk/scratch/output/spec.md", {
      path: ".dahrk/scratch/output/spec.md",
      content: "# Spec\nhanded back\n",
    });
    assert.equal(r?.source, "tool-handoff");
    assert.match(r?.artifact.content ?? "", /handed back/);
  });
});

test("an interactive stage that writes its declared file resolves via declared-file over any handoff", () => {
  // Interactive stages now have full tool parity, so they can write the declared artifact directly.
  // A written declared file must win over a document also handed back through the tool.
  withWorktree((ref, dir) => {
    mkdirSync(join(dir, ".dahrk/scratch/output"), { recursive: true });
    writeFileSync(join(dir, ".dahrk/scratch/output/spec.md"), "# Spec\nwritten by interactive stage\n");
    const r = resolveStageArtifact(ref, ".dahrk/scratch/output/spec.md", {
      path: ".dahrk/scratch/output/spec.md",
      content: "# Spec\nalso handed back\n",
    });
    assert.equal(r?.source, "declared-file");
    assert.match(r?.artifact.content ?? "", /written by interactive stage/);
  });
});

test("scratch-scan finds a differently-named markdown in the output dir", () => {
  withWorktree((ref, dir) => {
    mkdirSync(join(dir, ".dahrk/scratch/output"), { recursive: true });
    // Declared spec.md was never written; the agent wrote specification.md instead.
    writeFileSync(join(dir, ".dahrk/scratch/output/specification.md"), "# Spec\nscanned\n");
    const r = resolveStageArtifact(ref, ".dahrk/scratch/output/spec.md", undefined);
    assert.equal(r?.source, "scratch-scan");
    assert.match(r?.artifact.content ?? "", /scanned/);
  });
});

test("changed-file fallback finds a new markdown written elsewhere in the worktree", () => {
  withWorktree((ref, dir) => {
    writeFileSync(join(dir, "REPORT.md"), "# Report\nchanged file\n");
    const r = resolveStageArtifact(ref, ".dahrk/scratch/output/spec.md", undefined);
    assert.equal(r?.source, "changed-file");
    assert.match(r?.artifact.content ?? "", /changed file/);
    assert.equal(r?.artifact.path, "REPORT.md");
  }, true);
});

test("returns undefined when no channel yields content", () => {
  withWorktree((ref) => {
    assert.equal(resolveStageArtifact(ref, ".dahrk/scratch/output/spec.md", undefined), undefined);
  }, true);
});

test("an empty/whitespace declared file falls through rather than publishing blank content", () => {
  withWorktree((ref, dir) => {
    mkdirSync(join(dir, ".dahrk/scratch/output"), { recursive: true });
    writeFileSync(join(dir, ".dahrk/scratch/output/spec.md"), "   \n");
    const r = resolveStageArtifact(ref, ".dahrk/scratch/output/spec.md", {
      path: ".dahrk/scratch/output/spec.md",
      content: "handed back",
    });
    assert.equal(r?.source, "tool-handoff", "blank declared file must not win over a real handoff");
  });
});
