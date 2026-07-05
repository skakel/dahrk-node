# Dahrk node

**Dahrk** is a Linear-native agent-workflow harness: a hosted **hub** dispatches deterministic,
multi-stage agent workflows, one per Linear issue, to deliberate **nodes** - the runnable in this
repository. Each stage runs in an isolated git worktree via a pluggable runtime (Claude Code, Codex,
Pi), and the node streams progress and results back to the hub. The engine that sequences stages is
pure TypeScript and never lets a model decide control flow; inference happens only *inside* a stage.

A node runs in one of two modes: an **edge node** (unmanaged, self-hosted, dials OUT - no inbound
ports) or a **managed node** (a Dahrk-hosted container pool). This repo is the **open node**: it has
no dependency on the hub, sharing only the wire protocol and types published as
[`@dahrk/contracts`](https://www.npmjs.com/package/@dahrk/contracts).

## Packages

| Package | What it is |
|---|---|
| [`packages/edge`](packages/edge) (`@dahrk/edge`) | The node's brain: the WebSocket client, the stage runner, tool/stage-entry policy, and stage-exit hooks. |
| [`packages/executor-worktree`](packages/executor-worktree) (`@dahrk/executor-worktree`) | The worktree executor: runner adapters (Claude Agent SDK, Codex SDK, Pi), a vendored GitService for worktree lifecycle, and the trace producer. |
| [`apps/edge-node`](apps/edge-node) (published as [`dahrk-node`](https://www.npmjs.com/package/dahrk-node)) | The installable entrypoint (command `dahrk`). Dials out to the hub over WebSocket and runs stages in worktrees. No inbound ports. |

## Install

Three channels, all installing the same version and providing the `dahrk` command. They need
**Node 22+** and a logged-in agent runtime (e.g. the `claude` CLI).

```bash
npm install -g dahrk-node                          # npm
brew install dahrkai/tap/dahrk                     # Homebrew
curl -fsSL https://dahrk.ai/install.sh | sh        # curl
```

Then connect a node with an enrolment token from [app.dahrk.ai](https://app.dahrk.ai) (run
`dahrk doctor` first to preflight Node, runtimes, hub reachability, and the token):

```bash
dahrk start --token <enrolment-token>
```

The node auto-detects which agent runtimes are installed (claude / codex / pi), mints and persists a
stable node id under `~/.dahrk/node.json`, dials out to the hub, and waits for Jobs. It advertises no
inbound ports; repositories are cloned on demand from each Job's git URL. To keep it running across
reboots, put it under a process manager (see [pm2](#run-it-durably-pm2) below).

## Run from source (development)

Requires **Node 22+** and **pnpm 11+**.

```bash
pnpm install
pnpm build
DAHRK_HUB_URL=ws://localhost:7071 pnpm --filter dahrk-node dev start --token <enrolment-token>
```

### Run it durably (pm2)

For a long-running node, use the bundled pm2 config - self-contained, runs from source, no build step:

```bash
pnpm install
export DAHRK_ENROL_TOKEN=<enrolment-token>   # or put it in a gitignored .env loaded via direnv
pm2 start ecosystem.config.cjs
pm2 logs dahrk-node                           # watch for the connect / welcome handshake
```

`pm2 restart dahrk-node` after a `git pull`; `pm2 stop` / `pm2 delete dahrk-node` to stop or remove.
The hub URL defaults to `wss://hub.dahrk.net`; override it by exporting `DAHRK_HUB_URL`. pm2 does not
parse `.env` itself, so either export the token in your shell or use direnv to load `.env` before
starting; never commit the token.

## Commands

```bash
dahrk start --token <t> [--name <n>] [--hub-url <u>] [--ephemeral]   # run the node
dahrk doctor [--token <t>] [--hub-url <u>]                           # preflight checks
dahrk help [start|doctor]                                            # usage
dahrk version                                                        # print the client version
```

`start` is the default, so `dahrk --token <t>` (no subcommand) still runs the node.

`dahrk doctor` runs a preflight before you commit to `start` and reports a clear pass/fail for:
the **Node version**, which **agent runtimes** are installed (with versions), **hub reachability**
(does the WebSocket connect?), and **token validity** (does the hub accept the enrolment token, or is
it missing / invalid / expired?). It exits non-zero if any check fails.

`--ephemeral` mints a throwaway node id for the run instead of reading/persisting `~/.dahrk/node.json`
- handy for CI or one-shot nodes that should leave no local state.

## Configuration

The token-only install needs just an enrolment token; the hub URL defaults to `wss://hub.dahrk.net`
and everything else is auto-detected or pushed from the hub on connect. Flags win over the matching
env var.

| Flag / env | Purpose |
|---|---|
| `--hub-url` / `DAHRK_HUB_URL` | Hub WebSocket URL (optional; defaults to `wss://hub.dahrk.net`). |
| `--token` / `DAHRK_ENROL_TOKEN` | Enrolment token (required). |
| `--name` / `DAHRK_NODE_NAME` | Display-name override (else the hub assigns one). |
| `DAHRK_RUNTIMES` | Comma list to override runtime auto-detection (`claude-code,codex,pi`). |
| `DAHRK_REPOS` | Optional self-hosted allowlist of registry repo ids to serve. |
| `DAHRK_CREDENTIAL_MODE` | `ambient` (host credentials) or `brokered` (hub-brokered tokens). |
| `DAHRK_NODE_ID` / `DAHRK_TENANT_ID` | Explicit identity overrides (managed profile). |
| `DAHRK_WORKTREES_DIR` / `DAHRK_MIRRORS_DIR` / `DAHRK_STATE_DIR` | Local paths (default under `~/.dahrk`). |
| `DAHRK_GIT_TOKEN` | Git credential for ambient-mode clone/push. |

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
[Keep a Changelog](https://keepachangelog.com/) and [semver](https://semver.org/):

1. Move the `## [Unreleased]` entries in [`CHANGELOG.md`](CHANGELOG.md) into a new `## [x.y.z]` section.
2. Bump `version` in `apps/edge-node/package.json` to match.
3. Commit, then tag and push:
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

[`.github/workflows/release.yml`](.github/workflows/release.yml) then gates that the tag equals the
package version, runs the CI checks, publishes to npm, bumps the Homebrew tap formula, and cuts a
GitHub release from the changelog. See [`packaging/homebrew/README.md`](packaging/homebrew/README.md)
for the tap, and the workflow header for the required secrets (`NPM_TOKEN`, `TAP_PUSH_TOKEN`).

## Attribution

`packages/executor-worktree` adapts worktree lifecycle logic from
[cyrus](https://github.com/cyrusagents/cyrus) (Apache-2.0), substantially rewritten. See
[`NOTICE`](NOTICE).

## Licence

Apache-2.0. Copyright Skakel Labs. See [`LICENSE`](LICENSE).
