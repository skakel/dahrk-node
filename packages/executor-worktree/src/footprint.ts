/**
 * The pure footprint core (DHK-615): turn `git diff --numstat` output into the blast-radius numbers the
 * node reports to the hub. Two functions, no git/fs/network reach so they can be unit-tested
 * exhaustively:
 *  - {@link parseNumstat} splits the raw numstat into structured rows, handling the two forms plain
 *    parsing misreads: binary rows (`-\t-\tpath`) and rename rows (`old => new`, brace form).
 *  - {@link deriveFootprint} sums files/added/removed, derives the changed top-level `scope`, and builds
 *    a capped `changedPaths` list with an explicit truncation marker so a huge diff never spills an
 *    unbounded array over the wire while the headline numbers stay exact.
 *
 * The impure caller (`git-service.commitAndPush`) runs the git command, scratch-filters the entries, and
 * calls these; see there for how the footprint is attached to the push result.
 */

/** One parsed `git diff --numstat` row: the (new, post-rename) path and its line delta. */
export interface NumstatEntry {
  /** Repo-relative path; for a rename this is the NEW path. */
  path: string;
  /** Lines added; 0 for a binary file (numstat reports `-`). */
  added: number;
  /** Lines removed; 0 for a binary file (numstat reports `-`). */
  removed: number;
  /** True when numstat reported the row as binary (`-\t-`). */
  binary: boolean;
}

/** The line-delta headline: how many files changed and the total added/removed across all of them. */
export interface Numstat {
  files: number;
  added: number;
  removed: number;
}

/** The blast radius of a delivered diff: line-delta headline, changed top-level `scope`, and a capped
 *  list of the changed paths with a truncation marker. */
export interface DiffFootprint {
  numstat: Numstat;
  /** Unique changed top-level path segments (first `/`-segment, or the whole name for a root-level
   *  file), sorted and deduped, over the FULL changed set (never capped). */
  scope: string[];
  /** Repo-relative changed paths, capped at the caller's cap; see {@link changedPathsTruncated}. */
  changedPaths: string[];
  /** True when the full changed set exceeded the cap and {@link changedPaths} was truncated. */
  changedPathsTruncated: boolean;
}

/**
 * Resolve the path column of a numstat row to the file's current (post-rename) path. A rename renders
 * either as a brace-scoped change within a common path (`src/{old => new}/file.ts`) or, with no common
 * part, as `old/a.ts => new/b.ts`. Non-rename rows pass through untouched.
 */
function resolveRenamePath(raw: string): string {
  const brace = /\{(.*?) => (.*?)\}/;
  if (brace.test(raw)) {
    // Take the `new` side of every `{old => new}` scope, then collapse any `//` an empty side leaves.
    return raw.replace(brace, (_m, _old, next) => next).replace(/\/{2,}/g, "/");
  }
  const arrow = raw.indexOf(" => ");
  if (arrow !== -1) return raw.slice(arrow + " => ".length);
  return raw;
}

/**
 * Parse `git diff --numstat` output into structured rows. Blank lines are ignored. A binary row
 * (`-\t-\tpath`) becomes a changed file with 0 added/removed and `binary: true`; a rename row's path is
 * resolved to the new path.
 */
export function parseNumstat(raw: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    // Three tab-separated fields: added, removed, path. The path is last and never contains a tab, so
    // split on the first two tabs only (a quoted path could in theory, but numstat does not tab-quote).
    const firstTab = line.indexOf("\t");
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const addedRaw = line.slice(0, firstTab);
    const removedRaw = line.slice(firstTab + 1, secondTab);
    const pathRaw = line.slice(secondTab + 1);
    const binary = addedRaw === "-" && removedRaw === "-";
    entries.push({
      path: resolveRenamePath(pathRaw),
      added: binary ? 0 : Number.parseInt(addedRaw, 10) || 0,
      removed: binary ? 0 : Number.parseInt(removedRaw, 10) || 0,
      binary,
    });
  }
  return entries;
}

/** The top-level segment of a repo-relative path: its first `/`-segment, or the whole name at root. */
function topLevel(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(0, slash);
}

/**
 * Derive the footprint from the (already scratch-filtered) numstat entries. `files` and the added/removed
 * sums are computed over EVERY entry and `scope` covers the full set; only the `changedPaths` list is
 * capped at `cap`, with `changedPathsTruncated` marking when the cap bit.
 */
export function deriveFootprint(entries: NumstatEntry[], opts: { cap: number }): DiffFootprint {
  let added = 0;
  let removed = 0;
  const scopeSet = new Set<string>();
  const allPaths: string[] = [];
  for (const e of entries) {
    added += e.added;
    removed += e.removed;
    scopeSet.add(topLevel(e.path));
    allPaths.push(e.path);
  }
  const changedPathsTruncated = allPaths.length > opts.cap;
  return {
    numstat: { files: entries.length, added, removed },
    scope: [...scopeSet].sort(),
    changedPaths: changedPathsTruncated ? allPaths.slice(0, opts.cap) : allPaths,
    changedPathsTruncated,
  };
}
