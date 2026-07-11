#!/usr/bin/env node
// Fail if CHANGELOG.md contains an internal tracker key. These are for our own tooling, never for the
// public changelog: `scripts/release.mjs` (`sanitizeNotes`) strips them from generated notes, but a
// hand-written key in a versioned section would sail through — `release.yml` publishes the section
// verbatim into the GitHub release. This lint is the guard that keeps one from ever landing.
//
// Keep the key prefixes in sync with sanitizeNotes in scripts/release.mjs.
import { readFileSync } from "node:fs";

const KEY = /\b(?:DHK|SKA|LABS|TEST|HAR|SL)-\d+\b/;
const path = new URL("../CHANGELOG.md", import.meta.url);
const lines = readFileSync(path, "utf8").split("\n");

const hits = [];
lines.forEach((line, i) => {
  const m = line.match(KEY);
  if (m) hits.push({ line: i + 1, key: m[0], text: line.trim() });
});

if (hits.length > 0) {
  console.error("CHANGELOG.md contains internal tracker keys — replace each with its GitHub PR ref (#N):\n");
  for (const h of hits) console.error(`  CHANGELOG.md:${h.line}  ${h.key}  ->  ${h.text}`);
  console.error(`\n${hits.length} leaked key(s). Public notes reference the PR, never the tracker key.`);
  process.exit(1);
}
console.log("changelog lint OK: no internal tracker keys");
