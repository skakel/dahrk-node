# @dahrk/executor-worktree

The executor behind the Job contract: it runs a stage in a git worktree.

- **GitService** (`src/git-service.ts`): `createGitService()` - `createWorktree` / `teardownWorktree`
  + base-branch resolution over `git worktree`, adapted from cyrus and stripped to pure git/node we own
  (zero cyrus deps; `execFileSync` arg arrays, no shell interpolation). One worktree per run on a
  `dahrk/<runId>` branch with a `.dahrk/scratch` dir.
- **Trace producer** (`src/trace-writer.ts`): `createTraceWriter()` writes the normalised
  `trace.jsonl` (writer-owned monotonic `seq`) + `meta.json` and spills large payloads to `blobs/`,
  under `traces/<stageId>/attempt-<n>/`.
- **Mock Runner** (`src/mock-runner.ts`): a no-LLM `Runner` emitting a deterministic
  thought/action/observation/response trace, so the edge + worktree + trace + policy path can be
  exercised without a live model. `makeRunner(runtime)` returns it.
- **Runner adapters**: thin wrappers over the Claude Agent SDK and Codex SDK behind the `Runner`
  interface, with the `dahrk_stage_complete` injected tool; the Claude adapter reuses cyrus's
  `AgentSessionManager` mapping.
- **Component provisioning** (`src/pack-cache.ts` + `src/overlay.ts`): the central
  skills/commands/agents path. The **worktree is the delivery surface** - a centrally-provisioned
  component must physically exist under the worktree's `.claude/` for the Claude adapter
  (`settingSources: ["project","local"]`) to read it.
  - `createPackCache({ root, source })` is the **content-addressed cache**: each pinned component
    (`ComponentRef.contentHash`, a `sha256:<hex>` over its files) is fetched **once** through the
    injected `PackSource`, every byte is **verified** against the declared digests (a mismatch is
    rejected, never written - integrity is part of replay faithfulness), and written atomically under
    a CAS path keyed by the hash. A later `materialise` of the same hash is a cache hit that does not
    re-fetch. The production source (the hub catalogue) and tests (an in-memory fixture) share the
    `PackSource` seam.
  - `overlayComponents(...)` copies a run's pinned components into the worktree `.claude/`, normalised
    **per runtime**: Claude writes the files with **repo-local precedence** (a file the repo already
    ships wins; the central one is skipped, never clobbered), idempotently (an identical re-overlay is
    a no-op, so re-dispatch on the sticky worktree is safe); **Codex** has no skills/commands/agents
    surface, so it writes nothing and returns a warning per component. The edge invokes this at
    dispatch and **fails the stage closed** if provisioning errors (a missing pinned component is a
    correctness problem). The run pins the resolved set in run-state for faithful replay.

MCP/tools are inherited from the repo (`settingSources: ["user","project","local"]`, no
`strictMcpConfig`); no parallel MCP plane. Net cyrus runtime dependency: zero npm packages.

The `Job`/`Runner`/trace types come from [`@dahrk/contracts`](https://www.npmjs.com/package/@dahrk/contracts).

## Attribution

`src/git-service.ts` adapts worktree lifecycle logic from [cyrus](https://github.com/cyrusagents/cyrus)
(Apache-2.0 upstream), substantially rewritten and stripped of cyrus-core coupling; see the `NOTICE`.
