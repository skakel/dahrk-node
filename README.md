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
| [`apps/edge-node`](apps/edge-node) (`@dahrk/edge-node`) | The installable entrypoint (`dahrk-node`). Dials out to the hub over WebSocket and runs stages in worktrees. No inbound ports. |

## Quick start

Requires **Node 22+** and **pnpm 11+**.

```bash
pnpm install
pnpm build
DAHRK_HUB_URL=ws://localhost:7071 pnpm --filter @dahrk/edge-node dev --token <enrolment-token>
```

The node auto-detects which agent runtimes are installed (claude / codex / pi), mints and persists a
stable node id under `~/.dahrk/node.json`, dials out to the hub, and waits for Jobs. It advertises no
inbound ports; repositories are cloned on demand from each Job's git URL.

## Configuration

The token-only install needs just a hub URL and an enrolment token; everything else is auto-detected
or pushed from the hub on connect. Flags win over the matching env var.

| Flag / env | Purpose |
|---|---|
| `--hub-url` / `DAHRK_HUB_URL` | Hub WebSocket URL (required). |
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
pnpm build       # tsc across all packages
pnpm typecheck   # type-check only
pnpm test        # Node built-in test runner (no Docker, no network, no live models)
```

## Attribution

`packages/executor-worktree` adapts worktree lifecycle logic from
[cyrus](https://github.com/cyrusagents/cyrus) (Apache-2.0), substantially rewritten. See
[`NOTICE`](NOTICE).

## Licence

Apache-2.0. Copyright Skakel Labs. See [`LICENSE`](LICENSE).
