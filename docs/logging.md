# Logging, diagnostics, and what leaves your machine

**Confidentiality:** Public
**Status:** DRAFT - UNREVIEWED

How a Dahrk node logs, how to debug one, and - the part that matters if you are running a node on your
own infrastructure - exactly what does and does not leave the machine it runs on.

## The short version

A node writes **two logs, both local**:

| File | What it is |
|---|---|
| `~/.dahrk/logs/node.out.log`, `node.err.log` | The plain transcript: what the node printed, as it printed it. Captured by the service (launchd / systemd). |
| `~/.dahrk/logs/node.jsonl` | The node's **structured** log: one JSON object per line, with levels, timestamps, correlation ids and full error stacks. |

**Neither is sent anywhere.** The node never uploads its logs. There is no telemetry SDK in this
client, no crash reporter phoning home, and no flag that turns one on. If we need your logs to debug
something, we have to ask you for them - and `dahrk diagnose` exists to make saying yes safe (see
below).

## Reading them

```bash
dahrk logs                     # tail the transcript (what a healthy node is doing)
dahrk logs -f                  # ...and keep watching
dahrk logs --level error       # only what went wrong
dahrk logs --run <runId>       # everything about one run, end to end
dahrk logs --run <runId> --json | jq   # the raw records
```

`--level`, `--run` and `--json` read `node.jsonl`; on its own, `dahrk logs` tails the transcript.

**`--run` is the one worth knowing.** Every log line the node emits during a stage carries the same
identifiers the hub knows the run by (`runId`, `stageId`, `jobId`, `attempt`). So when a run misbehaves,
the hub's view of it and the node's view of it are the same run, and you can put them side by side.

## Levels: why the file is more verbose than your terminal

`DAHRK_LOG_LEVEL` controls what reaches **stdout** (default `info`). The **file** is written at `debug`
regardless.

That asymmetry is deliberate. Debug logging you have to switch on *before* the incident is close to
useless, because you find out you wanted it *afterwards*. So the node always writes the detailed record
to disk, and the terminal stays quiet. Disk cost is bounded: `node.jsonl` rotates at 10 MB and keeps
five generations.

| Variable | Default | Purpose |
|---|---|---|
| `DAHRK_LOG_LEVEL` | `info` | Level for stdout: `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` \| `silent`. |
| `DAHRK_LOG_FILE_LEVEL` | `debug` | Level for `node.jsonl`. |
| `DAHRK_LOG_FILE` | on | Set `0` / `off` / `false` to disable the file sink (containers with ephemeral disks, where stdout is already captured). |
| `DAHRK_CRASH_EXIT` | off | Set `1` to make the node exit on an uncaught exception rather than log it and carry on. |

At `debug` you additionally see every git operation - clone, mirror refresh, worktree create, fetch -
which is usually what you want when a stage fails before the agent ever starts.

## Crashes

An uncaught exception or unhandled rejection is logged with a full stack **and written to
`~/.dahrk/logs/crashes/<timestamp>.json`**, then the node carries on.

Two deliberate choices there:

- **A separate file, because the log rotates.** A crash-loop will happily push its own first cause out
  of `node.jsonl`, and the first cause is the one you need.
- **Carry on, rather than exit.** In this process the realistic source of a stray rejection is a
  background best-effort path (shipping a trace, tidying a worktree), and dying costs real work: a node
  that goes down mid-stage loses the in-memory record it uses to re-send finished results, so the hub's
  run can stall until it re-dispatches. Logging loudly and surviving is the better trade. Set
  `DAHRK_CRASH_EXIT=1` if you would rather your supervisor restart it.

## Secrets

A node holds real credentials: your SSH keys, your `gh` token, `DAHRK_GIT_TOKEN`, your Anthropic
session. Everything written to a log passes through a scrubber first
(`packages/edge/src/redact.ts`), which drops:

- values under any key that looks sensitive (`*token*`, `*secret*`, `*password*`, `authorization`, ...);
- credentials embedded in URLs - `https://user:secret@host`, the shape a **git remote** takes, and the
  shape that appears in the git error messages we now log;
- token-shaped strings anywhere in free text: `ghp_…`, `github_pat_…`, `glpat-…`, `sk-…`, `sk-ant-…`,
  `xox…`, JWTs, `Bearer …`, `AKIA…`.

It is deliberately over-eager. A redacted value costs you a re-run; a leaked token costs you rather more.

## `dahrk diagnose`: how to send us a log without regretting it

```bash
dahrk diagnose
```

Writes **one local file** containing: this node's id, name, tenant, version and host; the `doctor`
verdict; the tail of the structured log; and every crash record. Then it stops.

- It does **not** upload. There is no `--upload` flag, and there is not going to be one.
- The **enrolment token is removed**, not redacted - there is no marker left behind to tell anyone it
  was ever there.
- Your **source code, prompts, and issue content are not in it.**

It is plain JSON rather than a zip, for one reason: you can open it and read every byte before you
decide to send it. A bundle you have read is one you can consent to. That is the entire design.

## What the node sends the hub anyway (and always has)

Logs are not the only channel, and it would be dishonest to describe them as though they were. While a
stage runs, the node streams a **trace** to the hub: the agent's reasoning, its tool calls, and its tool
results. Tool results can include **file content the agent read from your worktree**. That is the
product working as designed - it is what renders in the run view and what the harness reasons over -
but it is a different thing from your logs, and it is governed by the hub's retention policy, not by
this document.

The distinction worth holding on to:

| | Where it goes |
|---|---|
| Your source tree, SSH keys, git tokens, Anthropic session, `.env` files | **Stay on this machine.** Never sent. |
| Node logs, crash records, support bundles | **Stay on this machine.** Only ever leave if *you* send them. |
| Agent trace events (reasoning, tool calls, tool results - which can quote file content) | **Sent to the hub** while a stage runs. |

For the full boundary - every field, both directions - see the harness's `docs/data-boundary.md`.

## Sources

- `packages/edge/src/logger.ts` (sinks, levels, rotation), `packages/edge/src/redact.ts` (scrubbing).
- `apps/edge-node/src/logs.ts` (`dahrk logs`), `apps/edge-node/src/diagnose.ts` (`dahrk diagnose`),
  `apps/edge-node/src/process-safety.ts` (crash handling).
- `dahrk-harness/docs/data-boundary.md` (what crosses the hub boundary).
