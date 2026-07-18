/**
 * Overlay pinned components into a run's worktree `.claude/` at dispatch.
 *
 * The worktree is the delivery surface: the Claude adapter reads `.claude/` straight off it
 * (`settingSources: ["project","local"]`), so a centrally-provisioned skill/command/agent must
 * physically exist there for the runner to pick it up. This step materialises each pinned component
 * through the {@link PackCache} and copies its files into the worktree, normalised per runtime:
 *
 *  - Claude (`claude-code`): write the files under `.claude/`, with REPO-LOCAL PRECEDENCE - if the
 *    repo already ships a file at the same path, keep the repo's and skip the central one (never
 *    clobber a repo file). Idempotent: re-overlaying identical bytes is a no-op.
 *  - Every other runtime (Codex, Pi, ...): no `.claude/` skills/commands/agents surface, so write
 *    nothing and record a warning per component (inline into the prompt or use Claude). The
 *    manifest bakes Claude-convention `.claude/` paths (see {@link PackCache}), so there is nothing
 *    to reshape for these runtimes; the only correct action is warn-and-skip. The contract is
 *    defined and traced now; per-adapter projection / prompt-inlining is a follow-up (DHK-172).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ComponentRef, Runtime } from "@dahrk/contracts";
import type { PackCache } from "./pack-cache.js";
import { readManifestFiles } from "./pack-cache.js";

export interface OverlayResult {
  /** Worktree-relative paths written by the overlay (Claude only). */
  written: string[];
  /** Worktree-relative paths skipped because the repo already ships its own (repo-local precedence). */
  skippedRepoLocal: string[];
  /** Human-readable notes (e.g. a non-Claude runtime cannot materialise a component). */
  warnings: string[];
}

export interface OverlayOptions {
  worktreePath: string;
  runtime: Runtime;
  components: readonly ComponentRef[];
  cache: PackCache;
}

/** True when the worktree already has identical bytes at `dest` (an idempotent re-overlay). */
function sameBytes(dest: string, bytes: Buffer): boolean {
  try {
    return readFileSync(dest).equals(bytes);
  } catch {
    return false;
  }
}

export async function overlayComponents(opts: OverlayOptions): Promise<OverlayResult> {
  const { worktreePath, runtime, components, cache } = opts;
  const result: OverlayResult = { written: [], skippedRepoLocal: [], warnings: [] };

  for (const ref of components) {
    // Only Claude has a `.claude/` component surface the runner reads. Every other runtime
    // (Codex, Pi, ...) would get files it never looks at, so warn-and-skip and name the component
    // rather than write it silently.
    if (runtime !== "claude-code") {
      result.warnings.push(
        `${runtime} runtime: ${ref.kind} \`${ref.name}@${ref.version}\` not materialised; inline into the prompt or use Claude`,
      );
      continue;
    }

    const { dir } = await cache.materialise(ref);
    for (const relPath of readManifestFiles(dir)) {
      const src = join(dir, relPath);
      const dest = join(worktreePath, relPath);
      const bytes = readFileSync(src);
      // Repo-local precedence: a file the repo already ships wins. Idempotency: an identical
      // already-overlaid file is not a clobber, so it does not count as repo-local.
      if (existsSync(dest)) {
        if (sameBytes(dest, bytes)) continue; // idempotent re-overlay, no-op
        result.skippedRepoLocal.push(relPath);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
      result.written.push(relPath);
    }
  }

  return result;
}
