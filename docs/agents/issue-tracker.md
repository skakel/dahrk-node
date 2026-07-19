# Issue tracker: Linear

Issues and PRDs for this repo live in **Linear**, not in GitHub Issues (the GitHub remote is
for code and PRs only). This repo maps to the **Dahrk** team (key `DHK`) in the `skakel`
Linear workspace.

## How to operate

- **File an issue**: use the `capture-issue` skill (workspace-level), which follows the
  conventions in `../linear-conventions.md`. Do not open GitHub issues for feature/bug tracking.
- **CLI**: the `linear-cli` skill wraps the `linear` CLI for scripted issue management.
- **MCP**: the Linear MCP tools (`mcp__claude_ai_Linear__*`) are available for reading and
  writing issues, comments, projects, and labels directly.
- **Team / keys**: this repo is the Dahrk product; tickets are `DHK-<n>`. Never put `DHK-…`
  keys in the public `CHANGELOG.md` (see `../../CLAUDE.md`) — they belong in
  `CHANGELOG.internal.md`.

## When a skill says "publish to the issue tracker"

Create a Linear issue in the Dahrk (DHK) team via `capture-issue` / the Linear MCP.

## When a skill says "fetch the relevant ticket"

Read the Linear issue by its `DHK-<n>` identifier via the Linear MCP (`get_issue`) or
`linear-cli`.

## Conventions

The canonical routing, label model, and project structure live in
`../linear-conventions.md` at the workspace root. Read it before filing.
