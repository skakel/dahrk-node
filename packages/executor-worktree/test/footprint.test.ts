/**
 * The pure footprint core (DHK-615): parse `git diff --numstat` output and derive the blast-radius
 * numbers the node reports to the hub - files/added/removed, the changed top-level `scope`, and a
 * capped `changedPaths` list with a truncation marker. No git, fs, or network reach, so every parsing
 * subtlety (binary rows, rename forms) and the cap are pinned here rather than through a full push run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseNumstat, deriveFootprint } from "../src/footprint.js";

test("parseNumstat reads added/removed/path from a plain numstat row", () => {
  const entries = parseNumstat("3\t1\tsrc/a.ts\n0\t5\tsrc/b.ts\n");
  assert.deepEqual(entries, [
    { path: "src/a.ts", added: 3, removed: 1, binary: false },
    { path: "src/b.ts", added: 0, removed: 5, binary: false },
  ]);
});

test("parseNumstat treats a binary row (-\\t-) as a changed file with 0 added/removed", () => {
  const entries = parseNumstat("-\t-\tassets/logo.png\n");
  assert.deepEqual(entries, [{ path: "assets/logo.png", added: 0, removed: 0, binary: true }]);
});

test("parseNumstat resolves a brace-form rename to the new path", () => {
  const entries = parseNumstat("2\t2\tsrc/{old => new}/file.ts\n");
  assert.equal(entries[0].path, "src/new/file.ts");
});

test("parseNumstat resolves an added/removed side of a brace rename (empty segment collapses)", () => {
  assert.equal(parseNumstat("1\t0\tsrc/{ => nested}/file.ts\n")[0].path, "src/nested/file.ts");
  assert.equal(parseNumstat("0\t1\tsrc/{nested => }/file.ts\n")[0].path, "src/file.ts");
});

test("parseNumstat resolves a plain `old => new` rename (no common prefix) to the new path", () => {
  assert.equal(parseNumstat("4\t4\told/a.ts => new/b.ts\n")[0].path, "new/b.ts");
});

test("parseNumstat ignores blank lines", () => {
  assert.equal(parseNumstat("\n1\t1\tx.ts\n\n").length, 1);
});

test("deriveFootprint sums files/added/removed over every entry", () => {
  const fp = deriveFootprint(
    [
      { path: "src/a.ts", added: 3, removed: 1, binary: false },
      { path: "src/b.ts", added: 0, removed: 5, binary: false },
      { path: "logo.png", added: 0, removed: 0, binary: true },
    ],
    { cap: 100 },
  );
  assert.deepEqual(fp.numstat, { files: 3, added: 3, removed: 6 });
});

test("deriveFootprint derives scope as unique top-level segments, sorted and deduped", () => {
  const fp = deriveFootprint(
    [
      { path: "src/a.ts", added: 1, removed: 0, binary: false },
      { path: "src/nested/b.ts", added: 1, removed: 0, binary: false },
      { path: "docs/c.md", added: 1, removed: 0, binary: false },
      { path: "README.md", added: 1, removed: 0, binary: false },
    ],
    { cap: 100 },
  );
  // `src` appears twice but collapses to one segment; a root-level file is its own scope entry.
  assert.deepEqual(fp.scope, ["README.md", "docs", "src"]);
});

test("deriveFootprint reports every changed path uncapped and untruncated under the cap", () => {
  const fp = deriveFootprint(
    [
      { path: "src/a.ts", added: 1, removed: 0, binary: false },
      { path: "src/b.ts", added: 1, removed: 0, binary: false },
    ],
    { cap: 100 },
  );
  assert.deepEqual(fp.changedPaths, ["src/a.ts", "src/b.ts"]);
  assert.equal(fp.changedPathsTruncated, false);
});

test("deriveFootprint caps changedPaths and marks truncation, keeping numstat/scope exact over the full set", () => {
  const entries = Array.from({ length: 250 }, (_, i) => ({
    path: `pkg${i}/file.ts`,
    added: 1,
    removed: 1,
    binary: false,
  }));
  const fp = deriveFootprint(entries, { cap: 100 });
  // The path list is capped...
  assert.equal(fp.changedPaths.length, 100);
  assert.equal(fp.changedPaths[0], "pkg0/file.ts");
  assert.equal(fp.changedPathsTruncated, true);
  // ...but the headline numbers and scope stay exact over ALL 250 entries.
  assert.deepEqual(fp.numstat, { files: 250, added: 250, removed: 250 });
  assert.equal(fp.scope.length, 250);
});
