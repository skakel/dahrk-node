# Changelog

All notable changes to the `dahrk-node` edge client are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Harden `deliver`: when a run branch adds nothing over the (possibly advanced) base - an empty delta,
  or one consisting solely of the engine-owned scratch dir or other git-ignored paths - the push now
  short-circuits to an explicit `noop` outcome. Nothing is pushed and no PR is opened; the run closes
  as a successful "already delivered" no-op rather than risking a base-advanced merge conflict on a
  stray scratch path. A genuine code delta still integrates and pushes as before. (DHK-318)

## [0.1.3] - 2026-07-07

### Changed

- Release tooling: harden generated release notes so internal identifiers never reach the public
 changelog. Linear-style keys, internal run IDs, and commit trailers are stripped from every notes
 source (hand-written, AI-drafted, or the commit-log fallback), drafts prefer GitHub `(#N)`
 references, and version headings are dated. (#10)
- Release tooling: add a manual "Preview release notes" CI workflow that drafts the notes for a
 prospective version without tagging or publishing, so they can be reviewed before a release. (#11)

## [0.1.2]

### Added

- Work-preservation backup push (#7): a new merge-free `mode: "backup"` force-pushes the run's
  HEAD to `dahrk/wip/<runId>` with no base merge or PR, so in-flight work survives without touching the
  integration branch.

### Fixed

- Stop masking push-integration merge failures. A push whose base merge failed before a merge even
  started (e.g. unrelated histories, no `MERGE_HEAD`) previously surfaced an opaque
  `git merge --abort` error that destroyed the real diagnostic. Such cases now report a distinct
  `diverged` outcome and re-throw genuine merge-start failures truthfully, with a merge-base
  short-circuit and a fail-fast guard against an unborn HEAD. (#6)

## [0.1.1]

### Fixed

- Point the default hub URL at the canonical hosted endpoint `wss://api.dahrk.ai`. The 0.1.0 default
  (`wss://hub.dahrk.net`) did not resolve, so a token-only `dahrk start` failed with
  `getaddrinfo ENOTFOUND hub.dahrk.net`. Override via `--hub-url` / `DAHRK_HUB_URL` is unchanged.
- Default the git commit author/committer identity email to `noreply@dahrk.ai` (was `noreply@dahrk.net`).

## [0.1.0]

First published release of the `dahrk-node` edge client.

### Added

- Installable edge client. Run `dahrk start --token <enrolment-token>` and the process becomes a
  self-managed node: it dials OUT to the hub over WebSocket (no inbound ports), auto-detects the
  agent runtimes installed on the host (Claude Code, Codex, Pi), mints and persists a stable node id
  under `~/.dahrk/node.json`, and runs each workflow stage in an isolated git worktree.
- Subcommand CLI: `dahrk start` (default), `dahrk doctor`, `dahrk help`, `dahrk version`.
  `dahrk doctor` preflights the Node version, installed runtimes, hub reachability, and token
  validity before you commit to `start`. `--ephemeral` mints a throwaway node id for CI / one-shot
  nodes.
- Token-only install: the hub URL defaults to the hosted hub, so only an enrolment token is
  required; `--token` / `--name` / `--hub-url` flags override the matching `DAHRK_*` env vars (the
  legacy `SKAKEL_*` names are accepted as aliases during the rename).
- Three install channels, all providing the `dahrk` command: npm (`npm install -g dahrk-node`),
  Homebrew (`brew install dahrkai/tap/dahrk`), and curl (`curl -fsSL https://dahrk.ai/install.sh | sh`).
- pm2 config (`ecosystem.config.cjs`) for running a durable node from source.
- Tag-driven release CI: a `vX.Y.Z` tag publishes `dahrk-node` to npm, bumps the Homebrew tap
  formula, and cuts a GitHub release.

[Unreleased]: https://github.com/dahrkai/dahrk-node/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/dahrkai/dahrk-node/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/dahrkai/dahrk-node/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/dahrkai/dahrk-node/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dahrkai/dahrk-node/releases/tag/v0.1.0
