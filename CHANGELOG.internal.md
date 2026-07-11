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

- Introduce this internal changelog and the split-changelog convention. `pnpm release` now rolls both
  files; CI's "changelog entry required" gate accepts a note in either file; the public changelog lint
  and GitHub-release extraction stay scoped to `CHANGELOG.md`. (DHK release-hardening follow-up)
