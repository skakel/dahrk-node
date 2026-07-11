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

