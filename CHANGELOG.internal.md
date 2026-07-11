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

