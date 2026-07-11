---
description: Autonomous release of dahrk-node — preflight, AI changelog audit, cross-repo dep check, smoke, then one Release PR for you to review and merge
argument-hint: <version>   # e.g. 0.1.8
---

You are driving a **dahrk-node release** to version `$ARGUMENTS` as an *autonomous executor*. Work
through the phases in order and **run straight through to the Release PR without asking the user
anything**. The PR is the review surface: the user reads it, merges it, and the merge does the rest.

**Do not ask for approval. Do not merge.** Your run ends when the PR is open.

Stop only on a **blocker** — a condition where continuing would ship something broken. Report it
plainly with the exact fix and halt. The blockers are: a failed preflight (Phase 1), a `@dahrk/*`
dependency that is unpublished or ships `src` (Phase 3), and a failed smoke test (Phase 4). Never
paper over one.

Context you must respect (also in project memory): publishing is automated — `pnpm release` opens a
PR, merging it pushes the tag, the tag publishes to npm. The external dep `@dahrk/contracts` MUST be
published with `pnpm publish` (never npm) and its versions must be live before this release. Never
`git push` to `main` directly.

## Phase 1 — Preflight (read-only)

Confirm, and report a compact checklist:
- No modified **tracked** files outside the two changelogs. (`release.mjs` tolerates changelog edits —
  that is by design, see Phase 2 — and ignores untracked files entirely, so scratch dirs like `Plans/`
  are not a blocker.)
- On `main`, and `git rev-parse HEAD` == `git rev-parse origin/main` (fetch first). `pnpm release`
  refuses otherwise.
- Tag `v$ARGUMENTS` does not already exist (`git tag -l`, and on origin).
- `gh auth status` succeeds.
- `$ARGUMENTS` is a clean semver above the latest tag.

If any fail, stop with the exact fix (e.g. "you have unmerged commits; land or stash them first").

## Phase 2 — Changelog audit (read-only, then write — NOT gated)

Two changelogs: `CHANGELOG.md` is **public** (ships in the GitHub release; no tracker keys) and
`CHANGELOG.internal.md` is **internal** (never published; tracker keys welcome). See its header.

1. List every PR merged since the last tag: `git log --oneline v<last>..origin/main`, and map commits
   to PRs. For each, `gh pr view <n>` for the title and body — and when the body is thin or absent,
   `gh pr diff <n>` to see what actually changed. A one-line title is not enough to write a good note;
   the substance comes from the diff.
2. Read the `[Unreleased]` section of **both** files. Cross-check: **does every PR have a note in the
   right place?** A user-facing change belongs in `CHANGELOG.md`; an internal-only one (refactor,
   tooling, deps) belongs in `CHANGELOG.internal.md`. A PR with no note anywhere is the failure this
   phase exists to catch (it is how #22/#23/#24 shipped undocumented, and how #31 nearly did).
3. **Write the corrected `[Unreleased]` sections directly.** Do not ask first — the user reviews them
   in the PR. Public notes: written for people running the client, British English, no em dashes, PR
   ref `(#N)`, no tracker keys, under the right `### Added` / `### Changed` / `### Fixed` heading.
   Internal notes: whatever helps contributors, tracker keys fine.
4. Verify the public file with `node scripts/lint-changelog.mjs` (it rejects `DHK-`/`SKA-`/`LABS-`/
   `TEST-`/`HAR-`/`SL-` keys). The internal file is exempt — that is the point of it.

**Leave the edits uncommitted.** Do not commit, do not branch, do not open a PR for them. Phase 5's
`pnpm release` carries them onto the release branch and folds them into the same commit as the version
bump, so the whole release is **one** PR. (Writing them to `main` first is what forced the two-PR
dance in 0.1.7.)

If both `[Unreleased]` sections are already complete and correct, write nothing and say so.

## Phase 3 — Cross-repo dependency check (read-only)

For each `@dahrk/*` dependency in `apps/edge-node/package.json`, `packages/edge/package.json`, and
`packages/executor-worktree/package.json`:
- Verify the pinned version resolves to a **published** release: `npm view <pkg>@<version> version`.
- Verify it ships **compiled** output, not source: `npm view <pkg>@<version> exports` must point to
  `./dist/*.js`, never `./src`. (This is the exact check that would have caught the 0.1.1 breakage.)

If a required version is unpublished or exposes `src`, **stop**: the dependency must be published
correctly first (contracts via `pnpm publish` from its repo).

## Phase 4 — Local smoke gate (read-only)

Run `bash scripts/smoke-pack.sh`. It packs the client, installs the tarball into a clean tree (deps
resolved from the registry), and runs `dahrk version`. If it fails, **stop** — the artifact does not
load; do not release. Report the error.

## Phase 5 — Execute (NOT gated)

Run `pnpm release $ARGUMENTS`. It branches `release/$ARGUMENTS`, sweeps Phase 2's changelog edits plus
both `package.json` bumps into one commit, pushes, and opens the Release PR with the public notes as
the body (so the same reviewed text becomes the GitHub Release notes).

Then confirm the result is what you expect: `gh pr diff <n>` should show the changelog notes **and**
both version bumps in a single commit.

## Phase 6 — Report and stop

Report and end your run. **Do not merge the PR** — that is the user's call, and it is the trigger that
publishes.

State:
- The PR URL, and the notes it carries (what will become the public release).
- That merging it pushes the `v$ARGUMENTS` tag (`tag-release.yml`), which publishes to npm, cuts the
  GitHub release, and bumps the Homebrew tap (`release.yml`) — with no further input needed.
- Any blocker or oddity worth knowing before they merge.

**Optional, only if the user asks after merging:** verify the release actually shipped —
`tag-release.yml` and `release.yml` green; `npm view dahrk-node version` == `$ARGUMENTS`;
`curl -s https://registry.npmjs.org/dahrk-node/latest | jq -r .version` == `$ARGUMENTS` (the document
`dahrk update` reads); the GitHub release `v$ARGUMENTS` exists with the changelog body; and
`dahrk update --check` from an older install reports the new version.
