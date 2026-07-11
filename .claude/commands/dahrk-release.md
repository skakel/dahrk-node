---
description: Guided, gated release of dahrk-node — preflight, AI changelog audit, cross-repo dep check, smoke, then pnpm release
argument-hint: <version>   # e.g. 0.1.7
---

You are driving a **dahrk-node release** to version `$ARGUMENTS` as a *guided executor with approval
gates*. Work through the phases in order. **Phases 1–4 are read-only.** Stop and get the user's
explicit approval before every mutating or publishing action (any changelog write, `pnpm release`,
merging the PR). If any phase surfaces a blocker, report it and stop — do not paper over it.

Context you must respect (also in project memory): `dahrk-node` publishing is automated — `pnpm release`
opens a PR, merging it pushes the tag, the tag publishes to npm. The external dep `@dahrk/contracts`
MUST be published with `pnpm publish` (never npm) and its versions must be live before this release.
Never `git push` to `main` directly.

## Phase 1 — Preflight (read-only)

Confirm, and report a checklist:
- Working tree clean (`git status --porcelain` empty).
- On `main`, and `git rev-parse HEAD` == `git rev-parse origin/main` (fetch first). `pnpm release`
  refuses otherwise.
- Tag `v$ARGUMENTS` does not already exist (`git tag -l`).
- `gh auth status` succeeds.
- `$ARGUMENTS` is a clean semver above the latest tag.

If any fail, stop with the exact fix (e.g. "you have unmerged commits; land or stash them first").

## Phase 2 — Changelog audit (read-only, then a gated write)

Two changelogs: `CHANGELOG.md` is **public** (ships in the GitHub release; no tracker keys) and
`CHANGELOG.internal.md` is **internal** (never published; tracker keys welcome). See its header.

1. List every PR merged since the last tag: `git log --oneline v<last>..origin/main`, and map commits
   to PRs (`gh pr view <n>`), noting each PR's title.
2. Read the `[Unreleased]` section of **both** files. Cross-check: **does every PR have a note in the
   right place?** A user-facing change belongs in `CHANGELOG.md`; an internal-only one (refactor,
   tooling, deps) belongs in `CHANGELOG.internal.md`. Flag PRs with no note anywhere (this is how
   #22/#23/#24 shipped undocumented).
3. Lint the **public** section: no internal keys (`DHK-`/`SKA-`/`LABS-`/`TEST-`/`HAR-`/`SL-` followed
   by digits — run `node scripts/lint-changelog.mjs`), every entry carries a `(#N)` PR ref, and each
   is under the right `### Added` / `### Changed` / `### Fixed` heading. The internal file is exempt
   from the key ban — that is the point of it.
4. If anything is missing or wrong, **draft the corrected `[Unreleased]` sections**, show them as a
   diff, and get approval before writing. Public notes: for people running the client, British English,
   no em dashes, PR ref `(#N)`, no tracker keys. Internal notes: whatever helps contributors, tracker
   keys fine.

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

## Phase 5 — Execute (GATED)

Only after Phases 1–4 pass and the user approves: run `pnpm release $ARGUMENTS`. Report the PR URL it
opens. Do not merge it yourself unless the user asks.

## Phase 6 — Merge & verify (GATED)

When the user is ready, merge the Release PR (or have them merge it). Then watch the automation and
verify the release actually shipped:
- `tag-release.yml` and `release.yml` runs go green (`gh run watch`).
- `npm view dahrk-node version` == `$ARGUMENTS`.
- `curl -s https://registry.npmjs.org/dahrk-node/latest | jq -r .version` == `$ARGUMENTS` (this is the
  document `dahrk update` reads).
- The GitHub release `v$ARGUMENTS` exists with the changelog body.
- `dahrk update --check` from an older install reports the new version.

Report a final summary: version shipped, PR/tag/release links, and any follow-ups.
