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

**On a node you run, neither is sent anywhere by default.** Log shipping is off for self-managed nodes,
and the hub refuses a self-managed node's log records even if one is sent. If we need your logs to debug
something, we have to ask you for them - and `dahrk diagnose` exists to make saying yes safe (see below).

The node does report its own **health** to the hub - uptime, version, active jobs, reconnect count, disk
free, error *counts*. That is metadata about the node, never about your code; see
[What your node sends](#what-your-node-sends) below for exactly what it is and how to turn it off.

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
| `DAHRK_TELEMETRY` | (unset) | `off` = send the hub nothing about this node. `health` = health metadata only, never logs. A ceiling the hub cannot raise - see [What your node sends](#what-your-node-sends). |

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

## What your node sends

Three separate channels, with three different rules. Conflating them is how people end up either
paranoid or complacent, and both are wrong.

### 1. Health telemetry - on, from every node

Your node tells the hub about **itself**, on each heartbeat: uptime, client version, jobs in flight,
how many times it has reconnected, worktrees on disk, free disk, which runtimes it found, and **counts**
of failures by category (`git`, `runtime`, `policy`, `hub`, `internal`).

That is the whole list. It contains no file paths, no repository or branch names, no command lines and
no error messages. It is numbers, a version string, and category counts - and that is structural, not a
promise about our good intentions: the type cannot hold anything else (`NodeHealth` in
`@dahrk/contracts`). Note the deliberate asymmetry - we ship the *count* of git failures, never the
message, because a count tells us your node cannot clone while a message would tell us **which private
repository it cannot clone from**.

Without this, we cannot tell you that your node is broken. That is why it is on.

### 2. Log shipping - **off** on your machines

Your node's log lines carry free text. A failed git operation quotes the remote it could not reach, the
branch it was on, the paths it was working with. So:

- **Self-managed node (yours):** shipping is **off**. The hub *refuses* your log records even if a
  client sends them - the decision is not the client's to make.
- **Managed node (ours):** shipping is on. We operate the machine, and we need its logs to run it.

You can turn shipping on deliberately, and off again. An operator with the portal can also turn it on
for a session while debugging a live problem; it reverts when the node reconnects.

### 3. Agent traces - on, and always have been

While a stage runs, the node streams a **trace**: the agent's reasoning, its tool calls, and its tool
results. **Tool results can include file content the agent read from your worktree.** That is the product
working as designed - it is what renders in the run view and what the harness reasons over - and it is
governed by the hub's retention policy. It is a different thing from your logs, and it predates all of
the above.

### Turning it off

```bash
DAHRK_TELEMETRY=off      # no health, no logs. Nothing about the node leaves the machine.
DAHRK_TELEMETRY=health   # health metadata only; refuse log shipping even if the hub asks.
```

**This is a ceiling the hub cannot raise.** The hub may ask for *less* than you allow; it can never ask
for more. That is enforced in `log-shipper.ts`, in a repository you can read - which is rather the point
of shipping an open-source client.

(Note that `DAHRK_TELEMETRY` governs what the node says about *itself*. It does not disable agent traces,
which are how the product works at all; if you do not want a stage's output reaching the hub, do not run
that stage.)

### Summary

| | Where it goes |
|---|---|
| Your source tree, SSH keys, git tokens, model-provider session, `.env` files | **Stay on this machine.** Never sent. |
| Node logs, crash records, support bundles | **Stay on this machine** on a node you run. Only leave if you enable shipping, or send a bundle. |
| Node health (uptime, version, counts) | **Sent to the hub.** Metadata only. `DAHRK_TELEMETRY=off` stops it. |
| Agent trace events (reasoning, tool calls, tool results - which can quote file content) | **Sent to the hub** while a stage runs. |

For the full boundary - every field, both directions - see the harness's `docs/data-boundary.md`.

## Sources

- `packages/edge/src/logger.ts` (sinks, levels, rotation), `packages/edge/src/redact.ts` (scrubbing).
- `apps/edge-node/src/logs.ts` (`dahrk logs`), `apps/edge-node/src/diagnose.ts` (`dahrk diagnose`),
  `apps/edge-node/src/process-safety.ts` (crash handling).
- `dahrk-harness/docs/data-boundary.md` (what crosses the hub boundary).
