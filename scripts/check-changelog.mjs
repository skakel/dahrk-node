#!/usr/bin/env node
// Fail if source changed but no changelog note was added. This is the single source of truth for the
// `changelog` gate in ci.yml — CI calls this script rather than reimplementing the rule in bash, so
// what you can run locally is exactly what CI enforces.
//
// Two modes:
//   CI     (BASE_SHA + HEAD_SHA set): diff merge-base(BASE,HEAD)..HEAD. Commits only, deterministic.
//   local  (no env): diff merge-base(origin/main, HEAD)..working tree, INCLUDING uncommitted and
//          untracked files. This matters — an agent runs this mid-stage, before anything is
//          committed (the edge node only commits at deliver), so a commits-only check would pass
//          vacuously and the agent would learn nothing until CI went red.
import { execFileSync } from "node:child_process";

const SRC = /^(?:packages|apps)\/[^/]+\/src\//;
const NOTE = /^CHANGELOG(?:\.internal)?\.md$/;

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const lines = (s) => s.split("\n").filter(Boolean);

const { BASE_SHA, HEAD_SHA } = process.env;
const ci = Boolean(BASE_SHA && HEAD_SHA);

let changed;
if (ci) {
  const base = git("merge-base", BASE_SHA, HEAD_SHA);
  changed = lines(git("diff", "--name-only", base, HEAD_SHA));
} else {
  let base;
  for (const ref of ["origin/main", "main"]) {
    try {
      base = git("merge-base", ref, "HEAD");
      break;
    } catch {
      // ref not present (shallow clone, no remote) — try the next one.
    }
  }
  if (!base) {
    console.error("check:changelog: no origin/main or main to compare against; skipping.");
    process.exit(0);
  }
  // `git diff <base>` compares base to the WORKING TREE, so uncommitted edits count. Untracked files
  // are invisible to it, hence the separate ls-files pass — a brand new source file must count too.
  changed = [...lines(git("diff", "--name-only", base)), ...lines(git("ls-files", "--others", "--exclude-standard"))];
}

const src = changed.filter((f) => SRC.test(f));
if (src.length === 0) {
  console.log("check:changelog OK: no changes under packages/*/src or apps/*/src — no note required");
  process.exit(0);
}
if (changed.some((f) => NOTE.test(f))) {
  console.log(`check:changelog OK: ${src.length} source file(s) changed and a changelog was updated`);
  process.exit(0);
}

const prefix = ci ? "::error::" : "";
console.error(`${prefix}Source changed but no changelog note was added. CI gates on this.`);
console.error("\nChanged under src/:");
for (const f of src.slice(0, 10)) console.error(`  ${f}`);
if (src.length > 10) console.error(`  ... and ${src.length - 10} more`);
console.error(`
Add an entry under the '[Unreleased]' heading of ONE of:

  CHANGELOG.md           a change a self-hoster would notice (behaviour, flag, fix).
                         British English, no em dashes, under ### Added / ### Changed / ### Fixed.
                         Never reference an internal tracker key here — 'pnpm lint:changelog' rejects it.

  CHANGELOG.internal.md  anything else: refactor, dependency bump, test, tooling, comment-only edit.
                         Tracker keys are welcome. This always satisfies the gate.

The gate fires on the PATH, not on judgement: a comment-only or dependency-only edit under src/ still
needs a note, and an internal one is a perfectly good answer.

Do not know the PR number yet? Omit the '(#N)' ref rather than inventing one — the release audit
backfills it. If this PR genuinely warrants no note at all, apply the 'no-changelog' label.`);
process.exit(1);
