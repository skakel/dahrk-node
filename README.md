# Dahrk node

**Deterministic multi-stage agent workflows, one per Linear issue, run on a node you own.**

Dahrk is a Linear-native agent-workflow harness. A hosted **hub** dispatches deterministic,
multi-stage agent workflows to **nodes** that run each stage in an isolated git worktree. The engine
that sequences stages is pure TypeScript and **never lets a model decide control flow**; inference
happens only *inside* a stage. That determinism boundary is the whole point: reproducible pipelines,
not an agent improvising its own steps.

This repository is that node: the installable `dahrk-node` client (command `dahrk`) you run yourself.

<!-- Hero demo GIF goes here once recorded (tracked separately). -->

## Honest open-core framing

The node is **Apache-2.0 and runs on your machine**. It dials OUT to the hub over WebSocket (no
inbound ports), auto-detects your agent runtimes (Claude Code, Codex, Pi), and streams progress and
results back. It has no dependency on the hub beyond the wire protocol and types published as
[`@dahrk/contracts`](https://www.npmjs.com/package/@dahrk/contracts).

It is also, by design, an **open-source edge for a hosted harness**: the node does nothing on its own.
The workflows, sequencing, and dispatch live in the hosted Dahrk hub, so you need a Dahrk account and
an enrolment token to do anything useful. Open node, hosted brain: we would rather say that plainly
than have you find out at the connect step.

Sign up and mint a token at [app.dahrk.ai](https://app.dahrk.ai); full docs live at
[dahrk.ai/docs](https://dahrk.ai/docs). If that model fits how you work, a ⭐ helps others find it.

## 30-second quickstart

Needs **Node 22+** and a logged-in agent runtime (e.g. the `claude` CLI). Pick any channel; all
install the same version and provide the `dahrk` command:

```bash
npm install -g dahrk-node                          # npm
brew install dahrkai/tap/dahrk                     # Homebrew
curl -fsSL https://dahrk.ai/install.sh | sh        # curl
```

Get an enrolment token from [app.dahrk.ai](https://app.dahrk.ai), preflight, then start the node:

```bash
dahrk doctor --token <enrolment-token>   # checks Node, runtimes, hub reachability, and the token
dahrk start  --token <enrolment-token>   # enrol, install the service, run - and hand back your prompt
```

`dahrk start` makes the node **always-on**: it installs itself as a native service, starts it, and
returns. The node comes back after a reboot and restarts on failure. Then:

```bash
dahrk logs -f     # watch it work
dahrk status      # enrolled? up? (local - dials nothing, works offline)
dahrk stop        # stop it (it stays stopped until the next `start`)
dahrk restart     # pick up a new client version, token, or runtime
```

The node auto-detects which runtimes are installed (claude / codex / pi), mints and persists a stable
node id under `~/.dahrk/node.json`, dials out to the hub, and waits for Jobs. It advertises no inbound
ports; repositories are cloned on demand from each Job's git URL.

Only one node runs per machine: they would share this machine's node id and race each other for Jobs, so
a second `start` refuses rather than dialling the hub twice.

### Don't want a daemon?

`dahrk start --foreground` runs the node in your terminal and blocks, exactly as it always did. Ctrl-C
stops it. Use it in a container, under pm2 or another supervisor, in CI, or just to watch a node work.
`DAHRK_FOREGROUND=1` is the same instruction as an environment variable, which is easier to set in a
Dockerfile or a pm2 config than an argument. A foreground node logs to its terminal, not to a file, so
`dahrk logs` has nothing to show for one.

### How the service works

`dahrk start` generates and registers a **launchd** LaunchAgent on macOS or a **systemd** user service on
Linux - no pm2, no root. (`dahrk service install` / `uninstall` still exist if you want to do that step
by hand; `dahrk service uninstall` is how you remove the service entirely, as opposed to stopping it.)

Because the node id is persisted at `~/.dahrk/node.json`, the service re-attaches as the **same** node
across restarts - no hand-set `DAHRK_NODE_ID`. The token (and any `--name` / `--hub-url`) is baked into
the service's environment block, not its command line, so it never shows up in `ps`. Your current `PATH`
is snapshotted into that block too, so the daemon finds `git` and the runtime CLIs (claude / codex / pi)
the same way your shell does - start the node from a shell where `dahrk doctor` already sees them.

- **macOS** writes `~/Library/LaunchAgents/ai.dahrk.node.plist` and loads it with `launchctl`.
- **Linux** writes `~/.config/systemd/user/dahrk-node.service`, runs `systemctl --user enable --now`, and
  enables **linger** (`loginctl enable-linger`) so the node starts at boot and survives logout - the
  thing a headless VPS needs. If enabling linger needs privilege on your host, run
  `sudo loginctl enable-linger $USER` once.

Both write the same log files - `~/.dahrk/logs/node.{out,err}.log` - which is what `dahrk logs` reads, so
it behaves identically on every host. They are rotated (one previous generation, `.1`) once they pass
10 MB.

On a clean Mac or a clean Linux VPS this yields a node that survives a reboot and re-attaches. A bad or
missing token exits 78 (`EX_CONFIG`): on Linux systemd stops the service rather than restarting it, and
on macOS launchd throttles retries to one every 10s - either way the misconfiguration stays visible in
the logs instead of hammering the hub. `dahrk status` tells a node that is **crash-looping** from one you
deliberately **stopped**, and exits non-zero only for the former, so it works as a health check.

### Staying current

An always-on node is started once and then runs for months, so it tells you when it is behind rather than
waiting to be asked: `dahrk start` offers to update (at a terminal), the running node notes it in the log
(`UPDATE_AVAILABLE:`) once a day, and `dahrk status` reports it from cache. Nothing ever updates itself -
run `dahrk update` when you want it. The check is capped at one registry read a day, fails silently when
the registry is unreachable (it can never delay or fail a start), and switches off with
`DAHRK_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER`, or `CI`.

## What's in this repo

A node runs in one of two modes: an **edge node** (self-managed, self-hosted, dials OUT - no inbound
ports) or a **managed node** (a Dahrk-hosted container pool). This repo is the **open node**, and
ships three workspace packages:

| Package | What it is |
|---|---|
| [`packages/edge`](packages/edge) (`@dahrk/edge`) | The node's brain: the WebSocket client, the stage runner, tool/stage-entry policy, and stage-exit hooks. |
| [`packages/executor-worktree`](packages/executor-worktree) (`@dahrk/executor-worktree`) | The worktree executor: runner adapters (Claude Agent SDK, Codex SDK, Pi), a vendored GitService for worktree lifecycle, and the trace producer. |
| [`apps/edge-node`](apps/edge-node) (published as [`dahrk-node`](https://www.npmjs.com/package/dahrk-node)) | The installable entrypoint (command `dahrk`). Dials out to the hub over WebSocket and runs stages in worktrees. No inbound ports. |

## Run from source (development)

Requires **Node 22+** and **pnpm 11+**.

```bash
pnpm install
pnpm build
DAHRK_HUB_URL=ws://localhost:7071 pnpm --filter dahrk-node dev start --token <enrolment-token>
```

### Run it durably from source (pm2)

Running an **installed** client? Prefer [`dahrk start`](#30-second-quickstart) above, which installs the
native service for you. For a long-running node **from a source checkout**, use the bundled pm2 config -
self-contained, runs from source, no build step. (It runs the node with `--foreground`: pm2 is the
supervisor, so the node must not try to install one of its own.)

```bash
pnpm install
export DAHRK_ENROL_TOKEN=<enrolment-token>   # or put it in a gitignored .env loaded via direnv
pm2 start ecosystem.config.cjs
pm2 logs dahrk-node                           # watch for the connect / welcome handshake
```

`pm2 restart dahrk-node` after a `git pull`; `pm2 stop` / `pm2 delete dahrk-node` to stop or remove.
The hub URL defaults to `wss://api.dahrk.ai`; override it by exporting `DAHRK_HUB_URL`. pm2 does not
parse `.env` itself, so either export the token in your shell or use direnv to load `.env` before
starting; never commit the token.

## Commands

```bash
dahrk start [--token <t>] [--name <n>] [--hub-url <u>] [--foreground] [--ephemeral]  # run the node
dahrk stop                                                           # stop it (stays stopped)
dahrk restart [--token <t>] [--name <n>] [--hub-url <u>]             # stop, then start
dahrk logs [-f] [-n <lines>] [--level <l>] [--run <id>] [--json]     # what has it been doing?
dahrk diagnose [--out <path>]                                        # a support bundle you can read
dahrk status                                                         # enrolled? up? (local, dials nothing)
dahrk run <workflow> [--repo <p>] [--hub-url <u>] [--token <t>]      # run a workflow (engine-backed)
dahrk doctor [--token <t>] [--hub-url <u>]                           # preflight checks
dahrk service install|uninstall [--token <t>] [--name <n>] [--hub-url <u>]  # the service, by hand
dahrk update [--check]                                              # self-update to the latest client
dahrk help [start|stop|restart|logs|diagnose|status|run|service|doctor|update]  # usage
dahrk version                                                        # print the client version
```

`start` is the default, so `dahrk --token <t>` (no subcommand) still runs the node.

`dahrk doctor` runs a preflight before you commit to `start` and reports a clear pass/fail for:
the **Node version**, which **agent runtimes** are installed (with versions), **hub reachability**
(does the WebSocket connect?), and **token validity** (does the hub accept the enrolment token, or is
it missing / invalid / expired?). It exits non-zero if any check fails.

`dahrk run <workflow>` runs a workflow locally against this node's worktree - the engine-backed twin
of `doctor`, and the first slice of a general `dahrk run`. The first workflow is `preflight`: it
sequences **check node**, **check repo**, and **check tools** stages, synthesises a plain-English read,
and links the full report at `app.dahrk.ai/r/<runId>`, streaming `[n/5] <stage>` progress as it goes.
It runs with no Linear, no OAuth, and no issue - just the machine and the engine - and exits non-zero
when the floor is unsound (old Node, no git repo, git missing, worktree unwritable). A tool or hub it
cannot reach is a finding, not a failure.

`dahrk logs` shows what the node has been doing. On its own it tails the transcript the service
captured. Pass `--level`, `--run` or `--json` and it reads `~/.dahrk/logs/node.jsonl` instead - the
node's **structured** log, which carries levels, timestamps, correlation ids and full error stacks, and
is written at `debug` even when your terminal is not. `--run <runId>` is the one to remember: node log
lines carry the same run/stage/job ids the hub knows the run by, so `dahrk logs --run <id>` and the
hub's view of that run describe the same thing from both ends.

`dahrk diagnose` writes a support bundle: node identity, version, host, the `doctor` verdict, the tail
of the structured log, and every crash record - in **one local JSON file you can open and read**. It
uploads nothing (there is no `--upload` flag), the enrolment token is removed rather than redacted, and
your source, prompts and issue content are not in it. It exists so that "can you send us your logs?"
is a question you can safely say yes to. See [`docs/logging.md`](docs/logging.md).

`dahrk update` upgrades the client in place to the latest published release. It reads this build's
version, asks the npm registry for the newest one, and - if you are behind - detects how you installed
(npm / Homebrew / curl) and runs the right upgrade, or prints the exact command when it cannot tell.
It reports `current -> latest`, and is a no-op when you are already current. `--check` reports whether
an update is available without applying it.

`dahrk service install` / `uninstall` register and remove the always-on service by hand. `dahrk start`
installs it for you, so `install` is rarely needed; `uninstall` is how you remove a node's service
entirely, as against `dahrk stop`, which stops it but leaves it installed so `start` is instant. See
[How the service works](#how-the-service-works) above.

`--foreground` runs the node in this terminal and blocks, instead of installing a service - for
containers, pm2, CI, or watching one work. `DAHRK_FOREGROUND=1` says the same thing by environment.

`--ephemeral` mints a throwaway node id for the run instead of reading/persisting `~/.dahrk/node.json`
- handy for CI or one-shot nodes that should leave no local state. It implies `--foreground`: a node with
no persistent identity has nothing coherent for a supervisor to restart on boot.

## Configuration

The token-only install needs just an enrolment token; the hub URL defaults to `wss://api.dahrk.ai`
and everything else is auto-detected or pushed from the hub on connect. Flags win over the matching
env var.

| Flag / env | Purpose |
|---|---|
| `--hub-url` / `DAHRK_HUB_URL` | Hub WebSocket URL (optional; defaults to `wss://api.dahrk.ai`). |
| `--token` / `DAHRK_ENROL_TOKEN` | Enrolment token (required). |
| `--name` / `DAHRK_NODE_NAME` | Display-name override (else the hub assigns one). |
| `DAHRK_RUNTIMES` | Comma list to override runtime auto-detection (`claude-code,codex,pi`). |
| `DAHRK_REPOS` | Optional self-hosted allowlist of registry repo ids to serve. |
| `DAHRK_CREDENTIAL_MODE` | `ambient` (host credentials) or `brokered` (hub-brokered tokens). |
| `DAHRK_NODE_ID` / `DAHRK_TENANT_ID` | Explicit identity overrides (managed profile). |
| `DAHRK_WORKTREES_DIR` / `DAHRK_MIRRORS_DIR` / `DAHRK_STATE_DIR` | Local paths (default under `~/.dahrk`). |
| `DAHRK_GIT_TOKEN` | Git credential for ambient-mode clone/push. |
| `DAHRK_LOG_LEVEL` | Level for stdout (default `info`). The log **file** is written at `debug` regardless - see [`docs/logging.md`](docs/logging.md). |
| `DAHRK_LOG_FILE_LEVEL` / `DAHRK_LOG_FILE` | Level for `node.jsonl` (default `debug`); set `DAHRK_LOG_FILE=0` to disable the file sink. |
| `DAHRK_CRASH_EXIT` | Set `1` to exit on an uncaught exception rather than log it and carry on. |
| `DAHRK_TELEMETRY` | `off` = tell the hub nothing about this node. `health` = health metadata only, never logs. A **ceiling the hub cannot raise**: it may ask for less, never more. Self-managed nodes ship no logs by default anyway - see [`docs/logging.md`](docs/logging.md). |

> The legacy `SKAKEL_*` names are still accepted as aliases for every `DAHRK_*` variable during the
> rename transition. See [`.env.example`](.env.example).

## Development

```bash
pnpm build       # tsup bundles the `dahrk-node` client; tsc across the library packages
pnpm typecheck   # type-check only
pnpm test        # Node built-in test runner (no Docker, no network, no live models)
```

## Releasing

The `dahrk-node` client (in `apps/edge-node`) is published to npm on a git tag. Releases follow
[Keep a Changelog](https://keepachangelog.com/) and [semver](https://semver.org/).

**Guided path (recommended):** run `/dahrk-release <version>` in Claude Code. It runs the preflight,
audits the changelog against the PRs merged since the last tag (backfilling any note that is missing),
checks that every `@dahrk/*` dependency is published and ships compiled output, smoke-tests the packaged
client, and then runs `pnpm release` — all without stopping to ask. It halts only on a blocker: a failed
preflight, a dependency that is unpublished or ships `src`, or a failed smoke test.

You get **one** PR. Review it, merge it, and the merge publishes: nothing else is needed from you. The
command never merges on your behalf. The manual steps below are what it automates.

1. (Optional) hand-write this release's notes under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md);
   otherwise leave it empty and the release command drafts them from the commit log. These notes are
   public: write for people running the client, and reference the GitHub PR/issue as `(#123)` — never
   an internal tracker key. (`pnpm release` also strips internal keys, `run-…` IDs, and commit trailers
   as a backstop, but keep the source clean.) Internal-only changes (refactors, tooling, tracker-key
   context) go in [`CHANGELOG.internal.md`](CHANGELOG.internal.md) instead — a companion that is never
   published; `pnpm release` rolls both files together. See that file's header for which goes where.
2. Run `pnpm release <version>`, review/edit the changelog in the PR it opens, and merge.

`pnpm release` ([`scripts/release.mjs`](scripts/release.mjs)) bumps the version in both `package.json`
files, rewrites the changelog (moving `[Unreleased]` into a `[x.y.z]` section and repointing the
compare links), and opens a `Release x.y.z` PR. When `[Unreleased]` is empty it drafts the section from
the commits since the last tag using Claude; hand-written entries are always used verbatim.

It requires a clean tree **except** for uncommitted edits to the two changelogs, which it carries onto
the release branch and commits alongside the version bump. That is deliberate: it means notes written
in step 1 land in the same PR as the bump, so a release is never two PRs. Untracked files are ignored
outright (the release commit only stages tracked paths, so they can never reach it). Flags:
`--dry-run` (preview, write nothing), `--ai-polish` (refine even hand-written entries), `--no-ai` (skip
the model). The AI draft needs credentials via the Anthropic SDK (`ANTHROPIC_API_KEY`, or an
`ant auth login` profile); `--no-ai` runs without any.

Merging the PR lets [`.github/workflows/tag-release.yml`](.github/workflows/tag-release.yml) push the
`vX.Y.Z` tag, which triggers [`.github/workflows/release.yml`](.github/workflows/release.yml): it gates
that the tag equals the package version, runs the CI checks, smoke-tests the packaged client
(`scripts/smoke-pack.sh` — installs the tarball into a clean tree and runs it, so a broken artifact
never publishes), publishes to npm, bumps the Homebrew tap formula, and cuts a GitHub release from the
changelog. See
[`packaging/homebrew/README.md`](packaging/homebrew/README.md) for the tap, and the workflow headers for
the required secrets (`NPM_TOKEN`, `TAP_PUSH_TOKEN`, `RELEASE_PAT`, and optionally `ANTHROPIC_API_KEY`
for drafting changelogs in CI).

## Attribution

`packages/executor-worktree` adapts worktree lifecycle logic from
[cyrus](https://github.com/cyrusagents/cyrus) (Apache-2.0), substantially rewritten. See
[`NOTICE`](NOTICE).

## Licence

Apache-2.0. Copyright Skakel Labs. See [`LICENSE`](LICENSE).
