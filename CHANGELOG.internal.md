# Internal changelog

Internal-facing companion to [`CHANGELOG.md`](CHANGELOG.md). This file is **never published** — it is
not in any package's `files`, and the release CI cuts the GitHub release from `CHANGELOG.md` only. So
it is the place for notes that should not reach users: internal tracker keys (`DHK-…`), run IDs,
refactors, build/tooling changes, and context that matters to contributors but not to people running
the client.

Rules of thumb:

- **User-visible change** (a behaviour, flag, or fix a self-hoster would notice) → [`CHANGELOG.md`](CHANGELOG.md),
  referencing the GitHub PR as `(#N)`, never a tracker key.
- **Internal-only change** (refactor, test, CI, dependency plumbing) → here. Tracker keys are welcome.
- A change can appear in both: the public line for users, the internal line with the `DHK-…` link.

`pnpm release <version>` rolls the `[Unreleased]` section of **both** files into a dated `[version]`
section, so the two histories stay aligned. The public file is sanitised (keys stripped) at release;
this file is left verbatim.

## [Unreleased]

### Added

- **Give the Claude adapter an injectable session seam + characterisation tests (DHK-592).** Wrapped
  the Claude Agent SDK `query()` (and the interactive streaming `ManagedMailbox`) behind an injectable
  factory (`ClaudeRunnerDeps.createSession` / `ClaudeSessionLike`), mirroring Pi's
  `PiRunnerDeps.createSession` / `PiSessionLike`; the default remains the live `query()`-backed
  session, so production behaviour is unchanged. Added a scripted `FakeClaudeSession` and a
  `claude-adapter.test.ts` that drives `createClaudeRunner` without live inference or credentials -
  Claude's interactive settle logic is now covered end-to-end for the first time, pinning every exit
  kind (tool-exit, gate-summarise, idle-timeout, cancel, burst-coalescing) plus the batch/summarise
  outputs. Supporting change: `StageCompleteTool` gained a `capture()` entry point (the body the live
  MCP handler already runs) so the fake can drive a tool-exit without the SDK.

### Changed

- **Introduce the `RuntimeSession` port + shared loop; move Pi (embedded + container) onto it
  (DHK-593).** Defined a turn-level `RuntimeSession` port (`sendTurn` / `summariseTurn` / `cost` /
  `dispose`) plus `TurnResult` / `RuntimeSessionHooks` in `runner-shared.ts`, and lifted the interactive
  and batch orchestration out of `pi-adapter.ts` into `runInteractiveLoop` / `runBatchLoop` there. The
  loops own the seed → race → coalesce → settle state machine (tool-exit / gate-summarise / timeout /
  cancel) and reference only the port, never a `PiEvent`. A single `PiRuntimeSession` wrapper over the
  existing `PiSessionLike` transport holds the `consumePiEvent` mapping and stage-complete detection, so
  both Pi back-ends - embedded (`defaultCreatePiSession`) and container (`PiRpcSession` via
  `createIsolatedPiRunner`) - drive the one shared loop; the container `summariseTurn` tool-denial stays
  a documented no-op. The loop is now proven runtime-agnostically in a new `shared-loop.test.ts` against
  a `FakeRuntimeSession`, and the self-seed orchestration assertion migrated out of `pi-adapter.test.ts`,
  which keeps its Pi-specific coverage (trace envelope, cost, model resolution, MCP, DHK-504 gate,
  DHK-505 elicit, DHK-511 teardown). Per-exit `TurnResult` output (summary / status / artifact /
  sessionId / costUsd) is preserved; the one deliberate unification is that the interactive gate-exit
  summarise now denies tools and emits no trace, matching the batch summarise path. Seeds the
  `RuntimeSession` glossary entry in `CONTEXT.md`.
- **Unify the shared runtime-adapter helpers (DHK-591).** Collapsed the pieces the Pi and Claude
  adapters copied between themselves into single shared definitions in `runner-shared.ts`, with no
  behaviour change: `PolicyAwareRunnerContext` is now defined once and imported by both adapters
  (`pi-adapter.ts` re-exports it so existing consumers keep resolving the name), and the elicit
  outcome→text mapping lives in one `elicitOutcomeReply` helper used by both adapters and the Pi
  no-handler fallback, so the four tool-result strings appear exactly once. Also swept the stale
  "Codex" references (left over from the removed runtime, DHK-510) out of the executor-worktree
  adapter/mapper/shared comments.

## [0.1.21] - 2026-07-19

### Added

- **Wire brokered MCP into the Pi adapter via the node-local gateway proxy (DHK-507).** Added
  `buildBrokeredPiMcpServers` (pure, mirrors the Claude adapter's `buildBrokeredMcpServers`) and
  `createBrokeredMcpExtension` (an inline Pi extension whose async factory acts as an MCP client:
  connect over Streamable HTTP to `mcpProxyBaseUrl/<id>`, list tools, register each via
  `pi.registerTool`) in `pi-adapter.ts`; `defaultCreatePiSession` appends it alongside the tool-gate
  extension when the stage declares brokered servers. Widened the `stage-runner.ts` gateway gate from
  `claude-code` to a `runtimeUsesMcpGateway` predicate (Claude + Pi, not Codex). Declared
  `@modelcontextprotocol/sdk@1.29.0` as a direct dependency of `executor-worktree` (was a transitive
  peer of the Pi SDK) and a devDependency of `edge` (stub MCP server in the e2e test). Tests:
  `pi-mcp.test.ts` (pure builder + extension against a direct stub), a `runtimeUsesMcpGateway` unit in
  `stage-runner.test.ts`, and `pi-mcp-brokered.test.ts` (real gateway + extension, asserting the token
  is injected upstream and never reaches the agent-facing config). Pi 0.80.6 kept; no SDK upgrade.

### Changed

- **Clarify the batch stall-watchdog window computation (DHK-210).** Split the nested
  `stallMs` expression in `stage-runner.ts` into a `stallSource` fallback (config `stall_seconds` →
  env → 300s default) and a separate non-negative-integer clamp that mirrors `killMs`. No behaviour
  change: reading env has no side effects, so computing the source unconditionally is equivalent to
  the old interactive short-circuit.

- **Tidy the Pi adapter and its test path (DHK-508).** In `pi-adapter.ts`, `runInteractive` now casts
  `ctx` to the module's existing `PolicyAwareRunnerContext` (which already declares `emitElicit`)
  instead of an ad-hoc inline `RunnerContext & { emitElicit? }` that duplicated it, so both the
  tool-gate and elicit paths reach the ctx through one named shape. Removed a dead unused `here`
  binding from `pi-adapter.test.ts` and `pi-mappers.test.ts`. Type-only / test-only; no behaviour
  change (the 202 executor-worktree tests are unchanged and pass).

### Removed

- **Remove the `.skakel/scratch` transition scaffolding (DHK-565).** Deleted `installCompatSymlink`
  and `SCRATCH_DIR_COMPAT` from `git-service.ts`; removed the `.skakel/scratch` entry from
  `excludeScratchLocally`, the `git rm --cached` for the compat symlink in `commitPending`, the
  `SCRATCH_DIR_COMPAT` path checks in `isScratchPath`, and the `--exclude .skakel/scratch` from the
  `git clean` in `reconcileInterrupted`. Removed `SCRATCH_OUTPUT_DIR_LEGACY` and its fallback loop
  from `stage-runner.ts`. Removed the `.skakel/scratch/state.json` candidate from
  `worktree-reaper.ts`. Dropped `.skakel/scratch/` from `.gitignore`. Updated test assertions that
  checked for the compat path. No behaviour change for any worktree that was set up after 2/7.

- **Remove the Codex runtime adapter (DHK-510).** Deleted `codex-adapter.ts`, `codex-mappers.ts`, and
  their three test files; dropped the `codex` branch from `makeRunner`; removed the `codex --version`
  probe from `detect-runtimes`; removed `@openai/codex-sdk` from `packages/executor-worktree` and
  `apps/edge-node`. Pi reaches GPT/Codex models through OpenAI auth, so no model coverage is lost.

## [0.1.20] - 2026-07-18

### Added

- **CI: smoke-test `scripts/release.mjs` on every PR** (DHK-393). A new `smoke-release-script` job
  in `ci.yml` runs `node scripts/release.mjs <next-patch> --dry-run --no-ai` on every push to main
  and every pull request. Exercises `sanitizeNotes`, `rewriteChangelog`, `rollInternalChangelog`, and
  `bumpPackage` — the code paths that failed in the 0.1.11 incident — without writing files or
  touching git. Also catches changelog edits that would choke the rewriter.

- **`release.yml` now tells dahrk-web when a client is published.** A second `repository_dispatch`
  (`dahrk-node-released`, gated on a `WEB_DISPATCH_PAT` secret) fires alongside the existing harness
  notify, triggering the marketing site's deploy. `dahrk.ai/changelog` is generated from this repo's
  GitHub Releases feed, so a release changes that site without any commit landing there and nothing
  would otherwise rebuild it: the page would lag every release until an unrelated push happened to
  refresh it. Non-fatal and last, like the tap bump and the harness notify: npm and the GitHub release
  are the release, and an unreachable downstream repo must never fail a publish. If the secret is
  unset the step is skipped and the page can be refreshed by hand
  (`gh workflow run deploy.yml --repo dahrkai/dahrk-web`).

### Fixed

- **`scripts/release.mjs`: the commit-log range no longer crashes on a not-yet-created tag.** The
  `smoke-release-script` guard (DHK-393) runs the script in dry-run on every PR, including the release
  PR itself - where `[Unreleased]` is already rolled into a dated heading, so `prevTag` resolves to the
  version being released, a tag not created until merge. `draftSection` ran `git log v<version>..HEAD`
  against that missing revision and exited 128. The range now uses the tag only when
  `git rev-parse --verify` confirms it exists, falling back to full history otherwise. No effect on a
  real release (which always carries hand-written `[Unreleased]` notes and never enters `draftSection`).

### Changed

- **`GitService`: fold the repeated brokered-or-ambient credential setup into one `resolveRemoteAuth`
  helper** (DHK-252). The three real-remote network paths (`commitAndPush`, `backupPush`,
  `reconcileInterrupted`) each open-coded the same two lines - `setupAuth(token)` for the transient
  `GIT_ASKPASS` helper and `withTokenUser(url)` for the `x-access-token@` remote - so the shared
  credential plumbing the DHK-252 clean-up will build on now lives in one named place. Pure refactor:
  the helper returns the same `{ remote, authEnv, cleanup }` each site used before (raw `authEnv` so
  `commitAndPush`'s local merge still gets the exact env it did), so behaviour is byte-for-byte
  unchanged. `createWorktree` keeps its own auth handling: it drives the mirror through `ensureMirror`
  (which owns URL rewriting) and needs no real-remote URL.

## [0.1.19] - 2026-07-15

## [0.1.18] - 2026-07-14

### Added

- **`release.yml` now tells dahrk-harness when a client is published** (DHK-437, #69). A `repository_dispatch`
  carrying the new version fires at the end of the publish job and triggers the harness's
  `update-platform-node` workflow, so the platform edge node tracks the latest published client instead of a
  hand-maintained pin in the harness Dockerfile. That stale pin is what shipped a client which could not
  authenticate (#63) and silently stopped the harness's admin loop. Guarded like the Homebrew tap bump
  directly above it: last in the job, `continue-on-error: true`, and skipped entirely when
  `HARNESS_DISPATCH_PAT` is absent - npm and the GitHub release *are* the release, so an unreachable
  downstream must never fail a publish. Needs a new **optional** repo secret `HARNESS_DISPATCH_PAT` (a
  fine-grained PAT on `dahrkai/dahrk-harness`, Contents: read and write); without it the step no-ops and the
  harness is updated by hand with `gh workflow run update-platform-node.yml`.

### Changed

- **A rejected node now parks in-process rather than trusting its supervisor to stop it** (DHK-436, #68). The
  exit-78 contract only ever held on systemd (`RestartPreventExitStatus`) and pm2 (`stop_exit_codes`);
  launchd's `KeepAlive` takes no exit code, so macOS respawned the process forever. Parking is the only
  mechanism that actually stops the loop on all three, and it buys a rotated token healing a live node with no
  restart. The exit-78 path survives only for a node with no durable token source (`--ephemeral`, CI), which
  has nothing to re-read and so must fail fast.

- **`serviceEnv` no longer bakes `DAHRK_ENROL_TOKEN` into the unit; `~/.dahrk/node.json` is the single home**
  (DHK-436, #68). Two homes plus an env-over-disk preference is what made re-enrolment a no-op. No migration
  shim was written: a unit from an older client differs from what we render today, so the existing "is the unit
  on disk the one I would write?" self-heal rewrites it, and a supervised node prefers the disk in the
  meantime. `dahrk start --token` validates against the hub before writing, but only an outright rejection
  blocks the write - an unreachable hub is not evidence about the token.

## [0.1.17] - 2026-07-14

### Changed

- **Cost capture is now per-adapter, and only Claude and Pi can actually price a run** (DHK-434, #66). Pi reads
  the aggregate `getSessionStats().cost` its own session already computes, so a single read at settle covers the
  batch turn, every interactive turn, and the engine-owned summarise turn on the warm session. `getSessionStats`
  is declared **optional** on `PiSessionLike`: an older or minimal session omits it, and the adapter then reports
  no cost rather than a fabricated `0`. Any new fake session in a test that asserts on `costUsd` has to supply it.

- **Codex's cost gap is a deliberate known-unknown, not an oversight** (DHK-434, #66). The Codex SDK's `Usage` is
  token-only (`input_tokens` / `cached_input_tokens` / `output_tokens` / `reasoning_output_tokens`); there is no
  price field anywhere in its types, and a real figure would need a pricing table the client does not carry. So
  `codex-adapter.ts` leaves `costUsd` unset and emits `CODEX_COST_UNAVAILABLE_NOTE` on stderr, the same channel
  the adapter already uses for its other known-unknowns (MCP, interactive tool-exit). If a pricing table ever
  lands, that note is the thing to delete. Do not "fix" the $0 by writing a zero.

## [0.1.16] - 2026-07-13

### Changed

- **`runUpdate` now takes `saveResult` as an injected dep** and the test harness always supplies a fake (#62).
  Worth knowing because the bug it fixes is latent elsewhere: the `Partial<Deps>` + real-`defaultDeps` pattern
  used throughout the client means a test that simply omits a dep falls through to the real one. Here that
  meant the update tests wrote the developer's actual `~/.dahrk/node.json` - which they did, before the fake
  went in. Any new test against a `Partial<Deps>` entry point should assume an omitted dep is a live one.

- **The Pi model fix lives in `packages/executor-worktree/src/pi-adapter.ts`** and leans on Pi's own
  `registry.getAvailable()` rather than a hard-coded provider list (#63). Family matching strips a region or
  vendor prefix and a `-v1:0` revision, so `us.anthropic.claude-opus-4-8` and `claude-opus-4-8` are matched as
  one model. The model ids in the tests were read out of the built edge image, not invented, and the fix was
  exercised against the live SDK in that image.

## [0.1.15] - 2026-07-13

### Changed

- **New `apps/edge-node/src/ui.ts`: the client's one presentation layer.** Colour, status symbols, the
  key/value row, next-step hints, durations, and the confirm prompt now live in one module that every command
  renders through. Before this, each command had invented its own formatting (`status` had a padded label
  gutter, `doctor` had `[PASS]`/`[WARN]`/`[FAIL]` tags, `preflight` was the only place that had ever used a
  tick) and the identical `process.stdout.write` sink was copy-pasted into seven modules.

  Zero new dependencies: colour is `node:util`'s `styleText`, which has been in Node since 22 - the floor the
  client already requires. The capability gate (TTY / `NO_COLOR` / `TERM=dumb` / `FORCE_COLOR`) is our own
  rather than `styleText`'s, because that only learned to check the stream in 22.8 and we support 22.0, and
  because doing it ourselves makes the decision injectable and therefore testable.

- **`ServiceDeps.run` captures instead of inheriting stdio**, returning `{ code, output }`. `runCommands`
  prints the captured text only when a non-`ignoreFailure` command fails. This is what silences the
  `launchctl` chatter; the previous `ignoreFailure` flag suppressed the exit code but the output had already
  been streamed to the terminal by the time anyone looked at it. `spawnUpgrade` in `update.ts` does the same
  for the package manager.

- **`runNodeRestart` in `service.ts`**, replacing the `stop()`-then-`start()` composition in `main.ts`. It
  passes `alwaysLoad` to `runNodeStart`, which is a correctness fix, not an optimisation: `launchctl` returns
  before the job has finished going away (the race `foreignNodePid` already documents), so re-probing "is it
  running?" after the unload could see the node still up, no-op the start half, and leave it DOWN. A restart
  has already decided; it does not ask again.

- **`status.ts` splits into `gatherFacts` (IO) and `renderStatus` (pure)**, so `start` / `restart` / `stop`
  render the same canonical block rather than three hand-rolled summaries. New facts enter as fields on
  `StatusFacts` plus an injectable dep, keeping the renderer testable: pidfile liveness (via `resolvePresence`,
  which is what fixes the foreground node reading as "not installed"), `probeRuntimeStatuses` for versions,
  the job ledger for in-flight work, and `lastConnection` over the `EDGE_*` markers in `node.jsonl`.

  The two contracts `status` is built on are unchanged and still enforced by tests: it makes NO network
  request, and the only process it spawns is the supervisor probe. Every new fact is a local file read
  precisely so that stays true.

- `dahrk diagnose` strips ANSI from the doctor's report before writing it into the support bundle: stdout is a
  TTY when an operator runs it, so the report is correctly coloured, but the bundle is a JSON file someone
  will read in an editor.

## [0.1.14] - 2026-07-13

### Node announces its in-flight jobs on connect, and persists them across a restart, DHK-416

The node half of DHK-415 (whose hub-side adoption path shipped live but **dormant**: `reconcileAnnouncedJobs`
does nothing until a node actually emits `hello.inFlightJobs`). This is the activation switch.

- **`@dahrk/contracts` bumped `^0.2.0` -> `^0.3.0`** across `packages/edge`, `packages/executor-worktree`
  and `apps/edge-node`. Note 0.3.0 existed in the harness repo but **had never been published to npm** -
  DHK-415 bumped the version and did not release it, so `inFlightJobs`, `JobRequest.payloadVersion` and
  `isPayloadVersionSupported` were unreachable from here and no node-side work was buildable. Published as
  part of this ticket. A caret on a `0.x` version does not cross the minor, so the dep bump is load-bearing,
  not cosmetic.
- **New `packages/edge/src/job-ledger.ts`**: a durable JSON ledger (`~/.dahrk/jobs.json`, 0600, atomic
  temp+rename, corrupt reads degrade to empty). Injected through `EdgeOptions.jobLedger` rather than
  constructed in `packages/edge`, which has no dependency on the CLI app where the state-dir convention
  lives - the same seam as `onEnrolled`. Ephemeral nodes get the null ledger.
- **`ws-client.ts`**: `running` widened from `Set<jobId>` to `Map<jobId, JobLedgerEntry>` and written
  through to the ledger on start/finish for both the job and push paths; `sendHello` announces
  `inFlightJobs`; a new boot reconciliation runs (awaited) before `connect()`, ahead of the DHK-371
  worktree reap, which must not run first or there would be no worktree left to preserve a tail from.
- **`git-service.ts`**: new `reconcileInterrupted` (preserve the uncommitted tail on a local + remote
  `dahrk/wip/<runId>` ref, then hard-reset to the last completed commit). Not `backupPush`, though it
  shares `commitPending`: `backupPush` leaves HEAD advanced onto the tail (right before a reap, wrong
  before a re-run) and throws when it cannot reach the remote (wrong at boot, which runs before the socket
  is up and must still yield a clean tree offline). `refFor` now also carries `branch`, which it computed
  and dropped.

**The announce filter is a safety property, not tidiness.** The hub's gate version-rejects an announced job
whose `payloadVersion` is absent or malformed: it calls `markDispatchDead`, sends `cancel`, and fails the
awakeable. So announcing a job we cannot version-stamp does not fail to help, it **kills a healthy stage**.
`announceableJobs` therefore drops any entry without a version - which is exactly a push (`PushJob` carries
no `payloadVersion`; only `JobRequest` got the DHK-415 field) and any stage from a pre-DHK-415 hub. Pushes
are still ledgered, because their worktrees still need reconciling; they are just never announced.

**Two-state, not three.** The earlier refine answer called for `running` / `interrupted` / `abandoned`, but
the shipped wire frame is `{ jobId, payloadVersion }` with no `status` and no `checkpoint`, so it cannot
express them. This ships what the contract supports: announced = alive in this process, hub adopts; omitted
= not running, the DHK-414 lease lapses and the reaper re-dispatches. Resume-from-checkpoint is deferred -
it needs a checkpoint transport that does not exist on either side yet.

**Not done: killing the orphaned agent subprocess.** The runner is owned by the vendor SDK (`query()` /
`createAgentSession`), which surfaces no pid - cancellation is an in-process `AbortController` - so there is
nothing to signal. In practice the child dies with us (its stdio pipes break), and the dirty-tail reset is
what stops a hypothetical survivor's writes being mistaken for the agent's real output.

**Also stale in the ticket:** point 3's "heartbeat renews the DHK-414 lease" was already shipped hub-side in
DHK-414 (`bridge.ts` calls `store.renewNodeLeases(nodeId, ...)` off the existing heartbeat, keyed on the
socket). It needs no wire field and no node change; the ticket predates that merge.

### Pin the pi SDK to an installable version, DHK-343

- `pi-adapter` loaded `@earendil-works/pi-coding-agent` without the package being a declared dependency,
  and its docstring still described `0.73.1` as "unavailable on npm". Pinned to an exact `0.80.6` in
  `packages/executor-worktree/package.json` and refreshed the lockfile; `pnpm-workspace.yaml` sets
  `allowBuilds: false` for the `@google/genai`/`protobufjs` build scripts the new dependency pulls in, so
  `--frozen-lockfile` stays clean in CI.
- The ticket's premise - that the SDK had removed the model-resolution API - was checked and is false:
  `0.80.6` still exports `resolveCliModel`, so the working resolution path is left untouched. The change is
  a dependency pin plus a corrected docstring, no behaviour change. Three adapter tests added for the
  previously uncovered `runBatch` catch and `summarise` paths (143/143, `tsc` clean).
- **Not verified:** the runtime path against `0.80.6`. The SDK is loaded as `any` and the tests inject
  fakes, so the pin is proven to install and typecheck, not to execute.

### The changelog gate is now self-serviceable

- The `changelog` CI job was the single biggest source of red PRs: four of the last five failures, every
  one resolved by a human hand-pushing the note the author had missed. The harness half of that is already
  fixed - `eca1004` (dahrk-harness #346) added a changelog step to the code-writing stage prompts - but it
  landed at 16:48 UTC on 12 Jul, *after* both #54 (07:39) and #56 (15:51) had already gone red. Those two
  failed with no instruction in play at all.
- What was still missing is what that instruction points at. The prompt says "the README or contributor
  guide says which file takes which kind of change", and no such guide existed: `CLAUDE.md` - the one file
  every stage auto-loads - said nothing about the changelog, and there is no `CONTRIBUTING.md`. The routing
  rule lived only in `README.md` and this file's header.
- The rule now lives in one place, `scripts/check-changelog.mjs`, which `ci.yml` calls instead of
  reimplementing it in inline bash. It is also exposed as `pnpm check:changelog`, and locally it diffs the
  **working tree** (uncommitted and untracked included), so an agent mid-stage - which has not committed
  anything, since the edge node only commits at deliver - sees the real verdict rather than a vacuous pass.
- `CLAUDE.md` now states the rule categorically: a path under `packages/*/src` or `apps/*/src` needs a note,
  full stop, including comment-only and dependency-only edits; an internal note always satisfies the gate;
  omit the PR ref when you cannot know it. The gate's behaviour is unchanged - replayed against PRs #49-#56
  it returns the identical verdict on every one.

## [0.1.13] - 2026-07-12

### Multi-question AskUserQuestion no longer discards questions 2..N, DHK-406 (#54)

- `buildElicitFromQuestions` mapped `questions[0]` and threw the rest away, folding a prose note into the
  prompt asking the agent to "ask the rest later". The agent could not: the tool call had already returned.
  So the questions were not deferred, they were lost, and the stage continued on answers it never got. The
  degrade was designed under DHK-223's D5 philosophy (no denial, no forced retry loop) on the belief that
  the elicit surface could only ever carry one question — which is true of the *surface*, but was never a
  reason to drop the others.
- Replaced by an exported `async askQuestionsSequentially(questions, ask)` that maps each question and
  `await`s `ask` in turn. The router's one-elicit-in-flight rule forbids only *concurrent* asks, and `ask`
  clears `ref.settle` after each reply, so a sequential drain never trips it. One-question batches return
  the bare answer exactly as before; multi-question batches return answers labelled `Q1..QN` so the model
  can tie each reply back to its question.
- **Note for the next reader:** this deletes `buildElicitFromQuestions`, which #49 extracted and pinned
  only one release ago. That test asserted the drop *as correct behaviour* — it was, in the end, the
  reproduction for this bug. A test can pin a defect just as faithfully as a feature; #49's real value was
  making the behaviour visible enough to argue with.
- **Deliberately out of scope:** the second half of the issue title — a later reply falling through to
  `extractGate` and killing the stage. That gate hazard was confirmed **absent from this repo**; it lives
  in `dahrk-harness` and must be fixed there. Nothing in this change addresses it, and DHK-406 should not
  be read as closing it.
- Regression tests: both questions in a batch reach the human, and a "deny"-containing mid-interview reply
  is relayed intact rather than being read as a refusal. Suite 140/140, `tsc` clean.

## [0.1.12] - 2026-07-12

### Fix the flaky replay race that reddened main (#52)

- Tests only, no `src/` change. `main` went red on `build (22)` with the replay test seeing 1 received
  frame where it expected 2. Not fallout from #51: that branch already contained main's tip, so the merged
  tree was byte-identical to the branch head that went green — CI ran the same code twice and disagreed.
  A pre-existing race, first lost on a loaded runner.
- The replay path in `ws-client.ts` sends the cached frame and *then* logs the marker. `send()` only
  queues bytes; the hub's `message` handler pushes onto `inbound` a tick or more later. The test waited on
  the stdout marker and asserted on the hub's frame count — waiting on a *proxy* for the thing it asserts.
  Loopback delivery wins that race on an idle box and loses it on a starved runner.
- Fix: wait on the assertion's own observable (the inbound frame count), assert the markers after. Safe in
  that direction because the marker is written synchronously before the frame can reach the server. The
  `JOB_REPLAY` / `PUSH_REPLAY` assertions are retained, moved from wait-condition to assertion, so the
  tests still pin that the frame came off the replay path rather than a re-run. No sleeps, no tolerances.
  Send-then-log stays: it is the correct order.
- Closed, not won: injecting a 50ms delay into the hub's `message` handler makes the *old* assertions fail
  (reproducing the CI signature in both replay tests) and the new ones pass. Suite stressed 20x under CPU
  contention, 0 failures.

### Brokered runtime auth injection for Claude/Codex adapters, DHK-89 (#51)

- The hub already minted the provider key into `JobRequest.runtimeEnv` (gated on brokered credential-mode)
  and the edge already threaded it onto `RunnerContext` — but only the **Pi** adapter read it. So a
  `claude-code` or `codex` stage on a credential-less node (managed, or containerised) failed to
  authenticate with all the plumbing already in place. This wires the remaining two runtimes.
- `claude-adapter`: `runtimeEnv` becomes the Claude Agent SDK `query()` `env`, spread over `process.env` —
  load-bearing, because the SDK's `env` *replaces* the inherited environment rather than layering onto it,
  so a bare pass-through would strip `PATH`. One exported `runtimeEnvOptions` helper feeds `baseOptions`,
  so batch, interactive and summarise all authenticate.
- `codex-adapter`: `runtimeEnv` as the Codex SDK `env` at the single `new Codex()` site, filtering
  `undefined` values to satisfy the SDK's `Record<string, string>` type.
- Inert on ambient nodes by construction: no `runtimeEnv` means no `env` option, so the SDK keeps the
  operator's ambient login. Self-managed nodes are unchanged. The key rides the child-process env only,
  never the agent's tool surface.
- `claude-runtime-env.test.ts` / `codex-runtime-env.test.ts` pin both helpers (brokered key injected over
  an inherited env; ambient → no `env`).
- **Left open:** the E2E — a credential-less brokered node running a real `claude-code` stage authenticated
  only by the brokered key — has not been run. It needs a pool `runtime-cred` holding a live
  `ANTHROPIC_API_KEY`. Still tracked on DHK-89. Companion hub-side hardening PR landed in `dahrk-harness`.

### Runtime detection: retry, re-probe, and say so, DHK-390 (#50)

- Two independent faults compounded. `probe()` in `detect-runtimes.ts` mapped *every* failure — error,
  non-zero exit, timeout — to "not installed", on a single attempt with a 3s budget. And
  `resolveRuntimes()` ran once in `main.ts` and froze its answer into `EdgeOptions.runtimes`, which every
  `hello` and heartbeat then read for the life of the process. A transient miss was therefore latched:
  conflating "slow" with "absent" is the first bug, never re-asking is what made it permanent.
- The trigger we think we saw: a cold Node-based CLI on a host mid-IO-churn, which is precisely the state
  a node is in in the seconds after `dahrk update` restarts it. Reproduced deterministically — under a
  tight timeout the probe returns `[]`; on a calm host, `['claude-code','codex']`.
- `probeOnce` now distinguishes retryable from definitive: `ENOENT` (not on `PATH`) short-circuits with no
  retry, since waiting cannot conjure a binary; anything else (timeout, spawn hiccup, non-zero exit) is
  retried. Two attempts, 5s each. A CLI that keeps erroring is still, correctly, not advertised — the
  change narrows what counts as absence, it does not paper over a genuinely broken runtime.
- `ws-client.ts` gains the re-probe seam: `currentRuntimes` (mutable, replacing reads of the frozen
  `opts.runtimes`), an extracted `sendHello()`, and an interval (`runtimeRecheckMs`, default 60s,
  `unref`'d) that re-advertises when the detected set changes. Relies on the hub's `handleAdvertise`
  accepting a later `hello` as a re-advertisement. `reprobeRuntimes` is optional, so tests and embedders
  keep the old frozen-set behaviour; `main.ts` wires it to `resolveRuntimes`, which keeps `DAHRK_RUNTIMES`
  authoritative — a pinned override must never re-probe itself into something else.
- Observability, the part the incident actually lacked: `RUNTIMES_DETECTED` at boot, and
  `RUNTIMES_DEGRADED` when a runtime advertised on the *previous* boot is missing now. That diff needs the
  prior set, so `NodeState.runtimes` is persisted in `node.json` (skipped for `--ephemeral`, which has no
  disk). `readState` filters to the known runtime ids, so a hand-edited or future-client value cannot
  smuggle a bogus runtime into the diff.
- Regression test fails on the old single-attempt code: a fake `claude` that times out on the first probe
  and answers on the second. Plus round-trip and validation tests for the persisted set.
- Note for whoever reviews: the run's `reproduce`, `build` and `test` stages each reported "one or more
  tool actions were blocked by a deny-only policy guard" — the new `fs_confine` rule from #47 biting on a
  Dahrk-authored run. Worth a look at what it denied; it did not stop the work, but it is the first
  in-the-wild signal about that rule's false-positive rate.

### Test coverage for the AskUserQuestion degrade path, DHK-344 (#49)

- No behaviour change. DHK-344 itself was already delivered by #25 (`d8f3b5e`) — the
  `AskUserQuestion` → `elicit` wiring across `ask-user-question-tool.ts`, `claude-adapter.ts`,
  `stage-runner.ts` and `ws-client.ts` was fully in place, so the ticket needed no implementation.
  (The PR title says otherwise; it oversells what is really a test extraction.)
- What was actually missing was a test. The multi-question degrade rule — v1 surfaces only the first
  question and folds a note into its prompt rather than denying the call or forcing a retry loop
  (the DHK-223 D5 degrade philosophy) — lived inlined in the tool handler, reachable only through the
  MCP tool, and so was never asserted on directly.
- Extracted it verbatim into a pure `buildElicitFromQuestions` in `ask-user-question-tool.ts` and
  pinned both branches: a single question carries no note, and >1 surfaces only the first question's
  options with the total count named in the prompt.
- Known gap, left out of scope: a question with `multiSelect` set still emits no `console.warn`.

## [0.1.11] - 2026-07-11

### Filesystem confinement, DHK-392 (#47)

- Found in the wild: a stage agent ran a `find` rooted at `/` and scanned the operator's whole Mac,
  mounted network volumes included. Nothing stopped it and nothing could — `shell_guard` is a blocklist
  of seven commands (a root-anchored `find` is not one), `write_scope` only ever inspected the worktree's
  git *branch* and the repo name (a `Write` to `~/.zshrc` passes on an in-scope branch), `Read`/`Grep`/
  `Glob` were in no rule's tool set at all, and the Claude adapter set only `cwd`. The gap was already
  pinned in our own tests: they assert an env-file search and a credential-exfil `curl` *leak* under
  `shell_guard`.
- `fs_confine` (`packages/edge/src/builtins.ts`, `fs-roots.ts`, `shell-scan.ts`) is a path-aware rule, on
  by default whenever a Job has a worktree. Deliberately a **node default, not a workflow policy**: a run
  always has a worktree, so it needs no declaration and ships without a `@dahrk/contracts` release, and it
  fails closed. A future `fs_scope` policy widens the same roots — the shape is already there.
- The load-bearing subtlety: a linked worktree's `.git` is a *file* pointing into
  `~/.dahrk/mirrors/<repo>`, where index, refs and objects actually live. Deny the mirror and *every* git
  command in the worktree fails. Read-only allowances (`/usr`, `/opt`, `/etc/gitconfig`, TLS roots,
  `~/.gitconfig`, the pnpm store) exist for the same reason: deny them and `git commit` and every HTTPS
  call break. `~/.ssh`, `~/.aws`, `~/.gnupg`, keychains and `/Volumes` are denied above every allowance.
- The shell scanner is not a shell parser. It rests on one property: a token can only escape the worktree
  if it is *anchored* outside it (`/`, `~`, `$HOME`, or a `..` that climbs out); everything else resolves
  inside by construction. The work is in not mistaking a **pattern** for a path — which is precisely what
  `find / -path <glob>` is made of.
- Verified against real traffic rather than fixtures: 118 shell commands pulled from three run worktrees,
  each scanned against *its own* run's roots. Two denied, both the whole-disk scan itself; zero false
  positives. That corpus caught a bug fixtures never would have — `2>/dev/null` appears on roughly a third
  of all commands and the first cut denied it as an out-of-worktree write. Pinned as a test.
- Two limits, stated in the public note as well. Codex and Pi expose no pre-tool hook, so a breach is only
  detectable *after* the command ran; there the stage now fails loudly instead of leaving "one or more
  actions were blocked" at the end of a green run. The real fix for those runtimes is containerisation
  (out of scope). And this is a tool-argument guard, not a syscall sandbox: a path assembled inside a
  script and never named in the command is invisible to it. `DAHRK_SANDBOX=1` wires the Claude SDK's
  OS-level sandbox, which does close that, but stays opt-in — the SDK's doc comment ("filesystem
  restrictions come from permission rules, not these sandbox settings") contradicts its own schema, which
  exposes `filesystem.allowWrite`/`denyRead`. Not defaulting on behaviour unproven on a real run.
- Rollout: no running node picks this up by itself (`update-check.ts` only *logs* that an update exists),
  so the operator must `dahrk update` and restart. `DAHRK_FS_CONFINE=0` and `DAHRK_FS_EXTRA_ROOTS` are in
  the README because this fails closed on machines we cannot hot-patch.

## [0.1.10] - 2026-07-11

## [0.1.9] - 2026-07-11

### Observability, ring 0 of DHK-376 (#40)

- The node had **no logging library at all** — ~18 raw `process.stdout.write` calls, no levels, no
  timestamps, no correlation ids, no crash handlers. DHK-360 (half-open sockets), DHK-216 (reconnect
  zombies) and DHK-109 (WS flaps) were all diagnosed the hard way because of it.
- The worst finding: `GitService` has **always** had a `GitLogger` seam with meaningful calls on every
  clone, mirror refresh and worktree create, but **no production call site ever passed one**, so it
  resolved to `noopLogger`. Every git operation on every node ever run was silent. One-line fix.
- `packages/edge/src/logger.ts` — pino, two sinks, no transports (worker threads would break under the
  tsup bundle). stdout keeps the exact line-tagged markers byte-for-byte: `ws-client.test.ts` asserts
  `line.startsWith("JOB_STARTED:")` and the harness greps them to time a kill, so the markers are a
  contract, not laziness. The file sink (`~/.dahrk/logs/node.jsonl`) is always at `debug`.
- `packages/edge/src/redact.ts` — adapted from cyrus's `sentryScrubber` (Apache-2.0, credited in NOTICE),
  applied on pino's single `logMethod` choke point so no call site can forget it. Two additions over the
  original: inline token redaction (it only matched a token as a whole *string*, so
  `fatal: Authentication failed for 'https://ghp_x@github.com/o/r.git'` sailed through — and git errors
  are exactly what we now log), and URL credentials (`https://user:secret@host`).
- Correlation ids come from a per-job child logger bound from the same fields that build `TraceMeta`, so
  `dahrk logs --run <id>` and the hub's `/api/runs/:runId` describe one run from both ends. Reconnects
  log a `connectCount`.
- `apps/edge-node/src/process-safety.ts` mirrors the hub's `installProcessSafetyNet`. Crash records live
  in `logs/crashes/` separately from the log because the log rotates and a crash-loop pushes its own
  first cause out of it.
- Ring 0 is deliberately local-only: no telemetry SDK, no vendor key in an Apache-2.0 binary, no
  log-shipping path. `dahrk diagnose` writes a bundle and has no upload flag.
- Two bugs found while verifying: **EPIPE recursion** (`dahrk start | head` → closed stdout → EPIPE →
  uncaughtException → crash handler logged it *through the same stdout sink* → EPIPE again, writing bogus
  crash records; regression test added), and **Pi's container stderr was piped and never read** — an
  unread pipe fills its ~64 KB buffer and blocks the writer, a latent hang rather than a lost message.
- Follow-ups filed: **DHK-376** (the epic; ring 1 is fleet health over the WS `heartbeat` frame, today an
  empty `{type:"heartbeat"}` and so a free backwards-compatible insertion point, plus a `node_health`
  table and alerting). **DHK-374** (urgent) and **DHK-375**: the live privacy policy claims source code
  "never leaves your machine", which `data-boundary.md` contradicts, and promises a retention mechanism
  that is not built. Both gate any ring-1 telemetry disclosure.
- Docs: `docs/logging.md` here; `dahrk-harness/docs/data-boundary.md` §5 updated to classify the
  node-local log surface as non-crossing.

### Worktree and mirror, DHK-371 (#39)

- Every run was failing at stage start with `fatal: '<branch>' is already used by worktree at ...`. That
  was the visible symptom of three interacting defects, one of which was silently destroying uncommitted
  work.
- **D1, the dangerous one.** `ensureMirror` cloned with `--mirror`, which sets `remote.origin.mirror=true`
  and the refspec `+refs/*:refs/*`, so a fetch force-syncs *local* refs to match origin. Run branches live
  only in `refs/heads/*` until `deliver` pushes them and the forge deletes them again on merge, so origin
  has zero `skakel/issue-*` branches — and every mirror refresh deleted the branch of any run in flight.
  Fixed with a namespace split (`init --bare` + `+refs/heads/*:refs/remotes/origin/*` + `fetch --prune`).
  `git clone --bare` is deliberately not used: it copies remote heads straight into `refs/heads/*`,
  reintroducing the same footgun. `migrateMirrorConfig` converts existing mirrors in place, lazily, on the
  next refresh — no re-clone, no operator step, idempotent. It also unsets `remote.origin.mirror`, which
  would otherwise make any `git push origin` from the mirror a destructive mirror push.
- **D2, 65 GB.** `teardownWorktree` existed but its only caller returned early unless a retention policy
  was configured, and even then consulted an *in-memory* map, so every worktree from a previous process was
  orphaned for ever. One node reached 92 registered worktrees and 65 GB. There is no `run-finished` frame
  in `HubToEdge` (only `job`, `welcome`, `push`, `cancel`, `blob-put-url`), so the edge cannot be *told* a
  run is over and teardown cannot be signal-driven. New `worktree-reaper.ts` reconciles on-disk ∪
  git-registered state, never process-local memory, using `.skakel/scratch/state.json`'s mtime as a durable
  per-run clock and an activity grace to guard a second node process (there is no IPC).
- **D3.** Once D1 deleted the ref, `createWorktree` fell to `git worktree add -b` with no `--force`, and
  `die_if_checked_out` aborted on the stale worktree's dangling symref — while *leaving the branch ref
  re-created*, so the next attempt took the `--force` path and would base the run on the stale run's commit.
  Creation now prunes and evicts stale claims first but fails fast if the holder is a genuinely in-flight
  run (two live runs on one issue is a routing bug; a truthful error beats stomping a live worktree). Start
  point resolves `seedRef` (DHK-264 re-entry) → `origin/<branch>` → `origin/<baseBranch>`; a leftover local
  head is never a start point, which structurally kills the stale-base hazard. `--force -B` is transactional
  with the checkout, and a local tip holding unique commits is parked at `refs/dahrk/salvage/<branch>/<sha>`
  first.
- An `inFlight` leak would have defeated the reaper: it was incremented at job start but decremented only
  inside `finish`, which a throw before it (exactly the D3 failure) skipped, so the run stayed "busy" for
  the life of the process and every reaper pass keyed on `isBusy` skipped precisely the runs that most
  needed collecting. Moved to a `finally` around `runJob`.
- Five git-service regressions and an `inFlight` leak test, each verified to fail on the old code, plus
  five reaper tests including the restart-safety proof. Verified against the live `skakel-harness` mirror:
  it migrated in place, the in-flight run's branch survived, and a subsequent `fetch --prune` — the exact
  command that used to destroy every run branch — left it intact.

### Daemon-first CLI (#38)

- The upgrade hazard, and why it is handled: units written by 0.1.8 invoke **bare `dahrk start`**. Once
  `start` means "ensure running", the daemon's own `start` sees the service running (it *is* the service),
  exits 0, and `KeepAlive` restarts it into the same no-op every 10s — every service-installed node would
  silently stop serving Jobs on upgrade. Two mechanisms cover it: new units are explicit (`--foreground` in
  argv, `DAHRK_SUPERVISED=1` in the env block), and daemon-mode `start` **self-heals** by re-rendering the
  unit and rewriting + reloading it when it differs from disk. The self-heal is only sound because the
  render is deterministic — otherwise "differs → rewrite → reload" is an infinite restart loop, not a
  repair. A test pins exactly that, with a fallback to the foreground worker when there is no cached token
  to re-render with.
- The single-instance lock (`~/.dahrk/node.pid`) exits **non-zero** on refusal. The first cut exited 0,
  which a supervisor reads as a clean exit and restarts into the same refusal; there is now an end-to-end
  regression test.
- The update check fails open by construction: capped at one registry read a day, never prompts without a
  TTY, and a registry that *hangs* is aborted at 1.5s (there is a test for it), so it can never delay or
  fail a start.
- Follow-up: `install.sh` lives in another repo. It should default to an always-on node (`dahrk start` now
  does the install), opt out with `--no-service`, and print `dahrk status` / `logs -f` / `stop` as next
  steps. It pipes into a shell, so its `start` is not a TTY and the update check will never prompt.

## [0.1.8] - 2026-07-11

- Make a release one PR instead of two, and drop the approval gates. `scripts/release.mjs` now accepts
  uncommitted edits confined to the two changelogs and carries them onto the release branch, so notes
  backfilled by the audit land in the same commit as the version bump; previously they had to be
  committed to `main` first, which forced a separate changelog PR (#33 before #34 in 0.1.7). It also
  ignores untracked files, which cannot reach the release commit anyway (`git commit -am` stages only
  tracked paths) but used to fail preflight. `/dahrk-release` now runs straight through to the PR and
  asks nothing, halting only on a real blocker (failed preflight, a `@dahrk/*` dep that is unpublished
  or ships `src`, a failed smoke). It never merges: the PR is the review surface and the merge is the
  publish trigger.

- Protect `main`. It had no protection at all, so nothing stopped a red PR being merged — and since the
  merge is what tags and publishes, that meant a broken release could reach npm, which is unfixable
  (a version can never be reused). `build (22)`, `build (24)` and `changelog` are now required checks,
  with force-pushes and deletion blocked. Admins are not bound, so a solo maintainer can still merge
  their own release PR without a second reviewer. Also created the `no-changelog` label that `ci.yml`
  has always tested for but which did not exist, leaving the documented escape hatch unusable.

- Persist the enrolment token. New `apps/edge-node/src/state.ts` owns `~/.dahrk/node.json` (it was an
  inline read/write of `{nodeId}` in `main.ts`): a merging `writeState` so persisting a token cannot
  drop the id, `0600`/`0700` modes with an explicit `chmod` on write (`writeFileSync`'s `mode` only
  applies on create, so a pre-existing `0644` file from an older client is tightened the first time we
  write a token into it), and a corrupt file reading as empty state.
- Token resolution is now flag -> `DAHRK_ENROL_TOKEN` -> cached, shared by `start` / `doctor` / `run` /
  `service install`. `buildEdgeOptions` stays pure over env: `start` resolves the token and sets
  `DAHRK_ENROL_TOKEN` on its env copy before building the options.
- The cache is written from a new `EdgeOptions.onEnrolled` hook fired by the `welcome` handler in
  `ws-client.ts`, not at dial time, so only a hub-accepted token is ever persisted. It is wrapped in a
  try/catch: a disk failure logs `EDGE_ENROL_PERSIST_FAILED` and must never take down a healthy node.
  Persisting is a no-op when the token already on disk matches, so the reconnect loop does no IO.
- Sound because the token is a reusable pool-join token, not one-shot: the wire contract requires
  `enrolToken` on every `hello`, and the client already re-sent the same one on every reconnect.
- `onEnrolled` also carries the `welcome`'s `name` / `tenantId`, cached into `node.json` so `status` can
  name the node offline. The no-op-if-unchanged guard now spans all three fields, so the reconnect loop
  still does no IO in the steady state.
- `service.ts`: unit files are written `0600` + explicit `chmod` (same create-only-`mode` trap as
  `node.json`). The unit's env block carries the token, so the module's "never leaks through `ps`"
  claim was true of argv and false of the file it wrote.
- `service.ts`: new `stableNodeBin`. `process.execPath` resolves symlinks, so a Homebrew Node reports its
  versioned Cellar path; `brew upgrade node` then deletes the binary the unit execs, and launchd's
  `KeepAlive` + `ThrottleInterval: 10` crash-loops it silently forever. We now map `.../Cellar/<formula>/
  <version>/bin/node` to `.../opt/<formula>/bin/node`, but only when that alias CURRENTLY realpaths to the
  same binary - a stale symlink is never trusted. nvm / system layouts have no alias and pass through.
- New `status.ts` (+ `unitPath` / `statusCommand` / `parseServiceStatus` in `service.ts`): a local report,
  pure renderer + injected IO, no network by design. Exits 1 only on installed-but-not-running. Reports
  `envToken` separately from the cached token, so a node whose token comes from the unit's env block (or a
  pre-cache client) does not read as "not enrolled". The token is never printed, not even a prefix.

## [0.1.7] - 2026-07-11

- Default an interactive stage's exit to `either` rather than `gate` in all three runtime adapters
  (claude / codex / pi). With `gate`, `wantsTool` is false so the stage-complete tool is never
  offered, leaving the hub's allow-keyword scan as the only `ok` path. (DHK-363, #31)

- Harden the release process after the 0.1.5 incident: `scripts/smoke-pack.sh` packs the client,
  installs the tarball into a clean tree and runs `dahrk version` (wired into `ci.yml` and as the
  last gate before publish in `release.yml`); the build matrix now covers Node 22 and 24;
  `scripts/lint-changelog.mjs` rejects internal tracker keys; and a PR gate requires a changelog
  note for changes under `packages/*/src` or `apps/*/src` (escape: the `no-changelog` label). (#29)

- Backfill the 0.1.5 notes and correct the 0.1.4 section: `dahrk service install` was misfiled under
  0.1.4, and the read-only policy, worktree-base advertisement and interactive elicitation were
  undocumented. (#28)

- Introduce this internal changelog and the split-changelog convention. `pnpm release` now rolls both
  files; CI's "changelog entry required" gate accepts a note in either file; the public changelog lint
  and GitHub-release extraction stay scoped to `CHANGELOG.md`. (#32)

