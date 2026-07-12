# dahrk-node

The open-source **Dahrk** edge client: the installable software (`dahrk-node`) that, once run and
enrolled with the hub, becomes a **node** and executes workflow stages in a git worktree. Apache-2.0,
copyright Skakel Labs.

## Dahrk brand & naming (canonical: github.com/dahrkai/dahrk-hq)

Naming conventions for this repo (summary; the source of truth is `dahrk-hq`):

- **Entity model.** Product and agent = **Dahrk** / **@Dahrk**, a product of **Skakel Labs**. Product
  repos live under `github.com/dahrkai`.
- **Naming conventions.** npm `@dahrk/<x>` (one scope). Env vars `DAHRK_<AREA>_<NAME>` (legacy
  `SKAKEL_*` read as an alias during migration). Dotdir `.dahrk/`. Binary `dahrk-node`. Architecture
  words (Hub, Edge, Node, Engine, Run, Stage, Workflow, Broker) are concepts; do not brand them.
- **Domains.** `dahrk.ai` is canonical (docs at `dahrk.ai/docs`). The hub endpoint this client dials
  is **`api.dahrk.ai`**: use the `api` surface name in client config (`DAHRK_API_URL`,
  `DEFAULT_API_URL`, `wss://api.dahrk.ai`), not `hub`.
- **Nodes.** Client = the installable (this repo); Node = an enrolled running worker. **Managed** node
  (Dahrk-run) vs **self-managed** node (user-run: local machine, Docker, their cloud). Never say
  "unmanaged".
- **Credentials.** Self-managed nodes default to **ambient credentials** (git config, `gh`, SSH agent;
  no secrets through Dahrk). **Brokered credentials** (via the Broker) enable containers and CI.
- **Voice.** British English, no em dashes. Amber `#f5a524` is the only brand accent.

## Contributing: every source change needs a changelog note

**If your diff touches `packages/*/src/` or `apps/*/src/`, you must add a changelog note, or CI fails
the PR.** This is not a judgement call. The gate matches on the *path*, so a comment-only edit, a
dependency bump, or a type-only change under `src/` all need a note just as much as a new feature.
"No behavioural change, so no note" is the reasoning that reddens this repo most often; it is wrong.

Add the entry under the `[Unreleased]` heading of exactly one of:

- **`CHANGELOG.md`** for a change a self-hoster would notice (behaviour, flag, fix). Match the
  surrounding entries: British English, no em dashes, under `### Added` / `### Changed` / `### Fixed`.
  **Never** put an internal tracker key (`DHK-…`) in this file - `pnpm lint:changelog` rejects it.
- **`CHANGELOG.internal.md`** for anything else: refactor, dependency plumbing, test, tooling,
  comment-only edit. Tracker keys are welcome here. This always satisfies the gate, so when in doubt
  it is the right answer - an internal note beats no note.

Public entries cite the GitHub PR as `(#N)`. **If you do not know the PR number, leave the reference
out** rather than inventing one; the release audit backfills it. (Your commit is created before the
PR is opened, so during a workflow stage you cannot know N. That is expected.)

**Before you finish, run `pnpm check:changelog`.** It is the same check CI runs, it sees your
uncommitted work, and it tells you exactly what is missing. A red `changelog` job is always
preventable.
