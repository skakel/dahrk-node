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

