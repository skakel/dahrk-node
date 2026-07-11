# Changelog

All notable changes to the `dahrk-node` edge client are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Interactive stages that did not set `exit` could never finish. The default was `gate`, which
  disables the stage-complete tool, so the stage could only end successfully if your reply happened
  to contain the word "allow" or "approve" - a keyword nothing in the prompt or in Linear mentions.
  In practice the interview ran on until the idle window expired: the run timed out and the agent's
  work was discarded. The default is now `either`, which keeps the allow-word path and adds the tool
  exit, so a stage that omits `exit` can complete. (#31)

## [0.1.6] - 2026-07-11

### Fixed

- Fix a startup crash introduced in 0.1.5: `dahrk start` aborted immediately with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` because a bundled dependency shipped uncompiled
  TypeScript that current Node refuses to load from `node_modules`. The client now resolves the
  compiled build, so `dahrk start` runs again. Upgrade with `dahrk update` (or
  `npm install -g dahrk-node@latest`). (#27)

## [0.1.5] - 2026-07-11

### Added

- `dahrk service install` / `uninstall`: run the node as an always-on service without a process
  manager. It generates and registers a launchd LaunchAgent on macOS or a systemd *user* service on
  Linux that runs `dahrk start` on boot, restarts on failure, and streams logs - no pm2, no root. The
  persisted node id (`~/.dahrk/node.json`) means the service re-attaches as the same node across
  reboots; on Linux it also enables linger so a headless VPS starts at boot and survives logout. The
  token and any `--name` / `--hub-url` are baked into the service's environment (not its argv, so they
  never surface in `ps`), along with the operator's PATH so the daemon finds `git` and the runtime CLIs
  (claude / codex / pi) that a supervisor's minimal PATH would otherwise hide. A bad or missing token
  exits 78 (`EX_CONFIG`): systemd stops the service and launchd throttles retries to one every 10s, so
  the misconfiguration stays visible rather than hammering the hub. (#22)

- An enforceable `read_only` policy for a stage: it denies every write and shell tool outright while
  still allowing reads (`Read` / `Grep` / `Glob`). Previously `shell_guard: deny` only blocked a small
  dangerous-command blocklist, so effectful shells like `git push`, `curl -X POST`, and `>` / `>>`
  redirection writes slipped through - there was no way to express a genuinely read-only stage. (#24)

- Interactive stages now surface an agent's structured multiple-choice question as a proper Linear
  choice prompt with selectable options, instead of the question silently resolving to "the user did
  not answer" and the agent falling back to a plain-text paragraph nobody could reply to. Your pick is
  fed straight back to the agent and the stage continues. Only one question is shown at a time; if the
  agent asks several at once, the first is shown and the rest are noted. (#25)

### Changed

- The node now advertises its resolved worktree base to the hub when it connects, so a run's real
  worktree location (`~/.dahrk/worktrees/<runId>`, or your `DAHRK_WORKTREES_DIR`) is recorded in the
  hub's projection instead of an advisory placeholder. Observability only; never control flow. (#23)

## [0.1.4] - 2026-07-10

### Added

- `dahrk update`: a local, user-initiated self-update to the latest published client. It reads this
  build's version, asks the npm registry for the newest release (the single source of "latest" across
  every channel), and - when behind - detects how the client was installed (npm / Homebrew / curl) and
  runs the right upgrade in place, or prints the exact command when it cannot safely automate it. It
  reports `current -> latest`, is a no-op when already current, and `--check` reports availability
  without applying. No hub involvement; the same local path a future remote upgrade reuses. (#18)

- `dahrk run <workflow>`: run a workflow through the engine locally against this node's worktree, the
  engine-backed twin of `doctor` and the first slice of a general `dahrk run`. The first workflow is
  `preflight`, which sequences `check node` / `check repo` / `check tools` stages, synthesises a
  plain-English read, and links the full report at `app.dahrk.ai/r/<runId>`, streaming `[n/5] <stage>`
  progress as it goes. It runs with no Linear, no OAuth, and no issue, and exits non-zero only on an
  unsound floor (old Node, not a git repo, git missing, worktree unwritable); a tool or hub it cannot
  reach is a finding, not a failure. (#17)

### Fixed

- Harden `deliver`: when a run branch adds nothing over the (possibly advanced) base - an empty delta,
  or one consisting solely of the engine-owned scratch dir or other git-ignored paths - the push now
  short-circuits to an explicit `noop` outcome. Nothing is pushed and no PR is opened; the run closes
  as a successful "already delivered" no-op rather than risking a base-advanced merge conflict on a
  stray scratch path. A genuine code delta still integrates and pushes as before. (#16)

- Enforce edge policy decisions before Claude tool execution, and reject declared or handed-back
  artifact paths that escape the run worktree. (#19)

- A stage that had already finished no longer re-runs when the hub re-sends its frame. The node
  de-duped only against the set of in-flight jobs, which clears on completion, so a re-dispatched job
  started a second runner and redid the agent's work at full token cost; it now replays the cached
  result instead. A job that is neither running nor cached still re-runs, which is the genuine
  recovery path. (#20)

- Detect a dead hub connection instead of streaming into it. A half-open TCP connection leaves the
  WebSocket reporting itself as open, so a node could send trace events to a hub that no longer knew
  about it, never reconnect, and never receive its job again. The heartbeat now pings and terminates
  the socket after three missed replies, letting the node reconnect. (#20)

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

[Unreleased]: https://github.com/dahrkai/dahrk-node/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/dahrkai/dahrk-node/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/dahrkai/dahrk-node/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/dahrkai/dahrk-node/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/dahrkai/dahrk-node/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/dahrkai/dahrk-node/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/dahrkai/dahrk-node/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dahrkai/dahrk-node/releases/tag/v0.1.0
