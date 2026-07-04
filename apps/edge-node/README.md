# @dahrk/edge-node

The installable Dahrk edge node (binary `dahrk-node`). Runs on a Mac (primary) or a Linux VPS. Dials
out to the hub over WebSocket, advertises its repos and installed runtimes, and runs stages in
worktrees. No inbound ports.

Configured from env/flags (`DAHRK_HUB_URL`, repos, runtimes; the legacy `SKAKEL_*` names are still
accepted as aliases). See the repository root [README](../../README.md) for the full quickstart and
the environment-variable reference.
