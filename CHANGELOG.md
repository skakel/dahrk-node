# Changelog

All notable changes to the `dahrk-node` edge client are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A Pi stage on a credential-less node no longer asks the wrong provider for a key.** Pi resolves a model
  alias against its entire registry, roughly a thousand models across thirty-odd providers, and the plain
  aliases (`sonnet`, `opus`, `haiku`) resolve to Amazon Bedrock: `opus` becomes
  `us.anthropic.claude-opus-4-8`. A node with no login of its own is handed an Anthropic key by the hub, so
  Pi went looking for Bedrock credentials that were never going to be there, and the stage stopped on its
  first turn with `No API key found for amazon-bedrock` - having spent nothing and written no trace, which
  made it look like a broken node rather than a model pointed at the wrong door.

  A resolved model is now landed on a provider the node can actually authenticate to: if the one Pi picked
  is not among the models the registry reports as available, the same model is taken from a provider that
  is. It substitutes nothing - a Claude model is never quietly swapped for someone else's - so if no
  available provider carries that model, Pi's own error stands. Nothing changes on a node using its own
  ambient login.

### Added

- **`dahrk status` now tells you whether your client is up to date.** Previously the only way to find out was
  to run `dahrk update` and read what it said. The `Client` line now always states where you stand, and how
  old that information is: `up to date (checked 3h ago)`. An available update gets a line of its own directly
  under the node verdict, rather than a dim aside halfway down the report that was easy to read past.

  It says "as of" rather than "you are current" on purpose. `dahrk status` makes no network request, so it
  cannot know what the registry published a minute ago; what it can do is tell you what it last learned and
  when. Once that answer is old enough to mislead, it stops being stated as fact and points at the command
  that refreshes it.

- **`dahrk status --json` reports currency as `update: { kind, latest, checkedAt }`**, where `kind` is
  `available`, `current`, or `unknown`, so a monitoring script can alert on a fleet that is falling behind
  (and, just as usefully, on nodes that have never managed to check at all). The exit code is unchanged: an
  available update is not a health failure.

### Changed

- **The node checks for a new client every six hours rather than once a day**, so a running node's view of
  the registry is never more than a few hours old. Still jittered across a fleet, still fails open, still one
  small request per node per interval.

### Fixed

- **`dahrk update` now records what it learned.** It fetched the latest published version, printed it, and
  threw it away, so you could be told a new version existed and have `dahrk status` go on knowing nothing
  about it. This also makes `dahrk update --check` the way to refresh a stale answer by hand, which matters
  on a machine whose node is not running: the node's own periodic check was otherwise the only thing that
  ever updated it.

- **`dahrk status` could not tell "you are on the latest" from "I have never checked".** Both produced an
  identical bare version line, so an absence of news was doing duty for two opposite facts. They are now
  reported as what they are.

## [0.1.15] - 2026-07-13

### Added

- **`dahrk status` now tells you what the node is actually doing.** It leads with a single verdict line
  (running, stopped, crash-looping) instead of burying it at the bottom, reports the runtimes it can serve
  with their versions rather than just their names, and lists the stages it has in flight, read from the
  node's own on-disk job ledger. The hub line now says when the node was last known to be connected
  (`welcomed 2h ago`), taken from its log. It still dials nothing, so it stays instant and works offline,
  and it says "last known" rather than claiming a live connection it cannot verify without dialling. (#60)

- **`dahrk status --json`** prints the same facts as JSON, for a script or a monitoring check. The enrolment
  token is withheld, as it is from the human report. (#60)

- **`dahrk stop` and `dahrk restart` refuse to kill a stage in flight.** A stage is minutes to hours of agent
  time, and it was being interrupted silently by anyone restarting the node to pick up a new client. They now
  list what is running and leave the node up; `--force` interrupts it anyway. (#60)

- **`dahrk update` offers to restart the node.** A running node keeps executing the build it started with, so
  an upgrade does nothing until it is restarted. If a node is up, `update` now asks; where there is nobody to
  ask (a script, CI), it prints the right command instead.

### Fixed

- **`dahrk update` no longer tells you to run `dahrk start` to pick up the new version.** It does not work:
  `start` on a running node is a deliberate no-op, so it returned success and left the node on the old build.
  The command to use is `dahrk restart`, and that is now what it says (and offers to do). (#60)

- **`launchctl` no longer leaks `Unload failed: 5: Input/output error` into `start` and `restart`.** Making
  `start` idempotent means unloading the unit before loading it, and on a node that is not currently loaded
  launchd complains about that. The complaint was expected and ignored, but it was being printed anyway. The
  supervisor's output is now shown only when a step that mattered actually failed, where it is genuinely
  useful. (#60)

- **`dahrk restart` no longer claims the node "will stay stopped across reboots".** That is `stop`'s message,
  and it was untrue: `restart` was implemented as `stop` followed by `start`, so it printed both commands'
  output back to back. It is now one command that reports one outcome. It also no longer leaves the node
  recorded as deliberately stopped when the start half fails, which had been hiding a down node from the very
  health check meant to catch it. (#60)

- **`dahrk status` no longer reports a node started with `--foreground` (or under pm2, or in a container) as
  "not installed".** It asked the launchd/systemd service and nothing else, so a perfectly healthy node that
  it had not started itself was invisible to it. It now also reads the pidfile, which every node takes
  whoever supervises it. (#60)

- **`dahrk doctor` no longer fails with "no hub URL configured" on a default install.** The client falls back
  to `wss://api.dahrk.ai` when `DAHRK_HUB_URL` is unset, but the doctor did not, so it reported a failure
  against the very hub the node was connected to. The same fix applies to `dahrk run preflight`. (#60)

- **`dahrk update` no longer dumps the package manager's output on success.** A successful `npm install -g`
  prints a wall of `ERESOLVE` peer-dependency warnings about the client's own transitive dependencies: it is
  alarming, it is not actionable, and it is not a problem. It is hidden unless the upgrade fails, or you pass
  `--verbose`. (#60)

- **The CLI now speaks with one voice.** Every command shares the same status symbols, the same aligned
  layout, and the same style of next-step hints, where each had previously invented its own. Colour is used
  only to classify (pass, warn, fail) and is switched off automatically when the output is piped or redirected,
  when `NO_COLOR` is set, or on a terminal that cannot render it. (#60)

## [0.1.14] - 2026-07-13

### Added

- **The node now tells the hub what it is running, so a hub redeploy no longer restarts your stage.** When
  the connection moved to a new hub build midway through a stage (a redeploy, or a dropped socket), the
  new hub had no idea the node was already working: it dispatched the stage again, and the node ran it a
  second time from the beginning. A long stage could burn hours of agent time, and its cost, twice over.

  The node now announces its in-flight jobs when it connects, so the hub adopts the work already under way
  instead of duplicating it. An idle node says so explicitly, and a node running nothing it can identify
  stays silent rather than risk the hub cancelling healthy work. (#58)

### Fixed

- **Restarting the node mid-stage no longer silently re-runs the stage from scratch.** The node kept the
  list of what it was running in memory only, so a restart, a crash, or a machine reboot lost it entirely.
  The agent was killed, its result was never sent, and the hub simply dispatched the whole stage again -
  paying for all of it a second time, with no indication anything had gone wrong.

  The node now keeps that list on disk (`~/.dahrk/jobs.json`, alongside `node.json`; honours
  `DAHRK_STATE_DIR`, and is skipped entirely for an ephemeral node). On the next start it reconciles what
  the dead process left behind rather than pretending it never happened. (#58)

- **An interrupted stage no longer leaves half-written files for the next attempt to trip over.** An agent
  killed mid-edit leaves the worktree dirty, and because the worktree is reused for the same run, the
  re-dispatched stage started on top of a partial edit. That is worse than starting clean: it can quietly
  produce corrupt output that still looks like work.

  The node now preserves whatever the killed agent had written - committed to a disposable
  `dahrk/wip/<runId>` ref, pushed when it can reach the remote and kept locally when it cannot, so the work
  is never lost - and resets the worktree to the last commit the agent actually completed. (#58)

## [0.1.13] - 2026-07-12

### Fixed

- **When an agent asks you several questions at once, you now get asked all of them.** The elicit surface
  raises one question at a time, and the tool honoured that by surfacing only the first question of a batch
  and appending a note asking the agent to raise the rest later. The agent had no way to do so: the tool
  call had already returned, so questions two onwards were simply discarded, and the stage carried on with
  answers it never actually received.

  The batch is now drained through the same one-at-a-time surface, awaiting each answer before raising the
  next question, so every question reaches you and none is dropped. A single-question batch behaves exactly
  as before; a multi-question batch returns the answers labelled `Q1..QN` so the agent can tie each reply
  back to the question it answers. (#54)

## [0.1.12] - 2026-07-12

### Added

- **A node with no login of its own can now run Claude and Codex stages.** A managed node, or one you run
  in a container, has no ambient `claude` or `codex` session to borrow: nothing on the box has ever logged
  in. The hub already mints a provider key for those nodes and delivers it on the job, but only the Pi
  runtime was reading it, so a `claude-code` or `codex` stage on such a node simply failed to authenticate.

  Both adapters now pass that brokered key to the runtime as the CLI subprocess environment, layered over
  the inherited one so `PATH` and friends survive. The key rides the child process env only; it is never
  put on the agent's own tool surface.

  This changes nothing for a self-managed node. No brokered key on the job means no `env` override, so the
  runtime keeps using the ambient login on your machine exactly as before. (#51)

### Fixed

- **A runtime that was briefly slow to answer is no longer written off as missing for the life of the
  node.** At boot the node asks each agent CLI (`claude`, `codex`, `pi`) for its version to work out what
  it can run. That question was asked once, with a three second budget, and *any* unhappy answer - an
  error, a non-zero exit, a timeout - was read as "not installed". The answer was then frozen: it was what
  the node advertised to the hub on every reconnect and every heartbeat until someone restarted it.

  So a cold Node-based CLI on a busy host - a machine mid-IO-churn, which is exactly what a node looks
  like in the seconds after `dahrk update` restarts it - could take longer than three seconds to reply
  once, and be dropped. Not just for that probe: for good. Every stage that needed that runtime then
  failed the moment it was dispatched, and nothing anywhere said why. The runtime was installed and
  working the whole time.

  A probe now retries before concluding a runtime is absent (two attempts, and the budget is up from
  three seconds to five). A command that genuinely is not on `PATH` still gives up on the first attempt,
  because no amount of waiting will find it - the retry costs latency only on a host where something is
  actually struggling.

  The node also re-probes after boot, roughly once a minute, and re-advertises when what it finds differs
  from what it is advertising. A node that came up degraded now heals itself instead of waiting for a
  human to notice and restart it. `DAHRK_RUNTIME_RECHECK_MS` tunes the interval. (#50)
- **The boot log now says which runtimes it found.** A degraded advertisement used to be invisible: the
  only symptom was stages failing at dispatch, and you had to already suspect detection to go looking.
  The node now states the detected set at boot, and warns when a runtime it advertised on its previous
  boot is not there any more - a disappearance is worth shouting about, as distinct from a runtime that
  was simply never installed. (#50)

## [0.1.11] - 2026-07-11

### Fixed

- **A stage can no longer read your whole machine.** An agent looking for a package ran a `find` from the
  filesystem root and scanned the entire disk, mounted network volumes included - and nothing stopped it.
  Nothing could: `shell_guard` was a blocklist of seven dangerous commands (a root-anchored `find` is not
  one of them), `write_scope` only ever looked at the worktree's git *branch*, and the read tools - `Read`,
  `Grep`, `Glob` - were governed by nothing at all. The working directory was where a stage started, not a
  wall it could not climb.

  A stage is now confined to the run's worktree, its scratch directory, and the git object store the
  worktree depends on, plus temporary directories and the safe `/dev` sinks. It may **read** the toolchain
  and its config (`/usr`, `/opt`, your git config, the TLS roots, the pnpm store) and may write none of it.
  Your credentials (`~/.ssh`, `~/.aws`, `~/.gnupg`, keychains) and `/Volumes` are denied outright, above
  every allowance. On the Claude runtime the denial happens **before the tool runs**.

  Two honest limits. On Codex and Pi the runtime offers no pre-tool hook, so a breach is only detectable
  after the command ran - there the node now **fails the stage** rather than leaving a note at the end of a
  green run. And this is a tool-argument guard, not a syscall sandbox: a path assembled inside a script and
  never named in the command is not something it can see. `DAHRK_SANDBOX=1` adds the Claude SDK's OS-level
  sandbox, which does close that gap; it stays off by default until its behaviour is proven on real runs.

  Measured against the shell commands from three real run worktrees - 118 commands, each judged against its
  own run's roots - two were denied, and both were the whole-disk scan itself. If a legitimate command is
  wrongly denied anyway, `DAHRK_FS_EXTRA_ROOTS` widens the box and `DAHRK_FS_CONFINE=0` turns it off,
  without waiting for a release. (#47)

## [0.1.10] - 2026-07-11

### Added

- **Your node now tells the hub how it is doing.** On each heartbeat it reports its uptime, which client
  version it is, how many jobs it is holding, how many times it has reconnected, how many worktrees it has
  on disk, how much free disk it has, which runtimes it found, and **counts** of failures by category.

  That is the whole list, and it is worth being precise about what is *not* in it: no file paths, no
  repository or branch names, no command lines, and no error messages. It is numbers, a version string and
  category counts - and that is structural rather than a promise about our carefulness, because the type
  cannot hold anything else. Note the deliberate asymmetry: we send the *count* of git failures and never
  the message, because a count says your node cannot clone, while a message would say **which private
  repository it cannot clone from**.

  Without this we could not tell you your node was broken, only that it had pinged recently. A node
  crash-looping, wedged on a stage, out of disk, or reconnecting every thirty seconds under a process that
  looked fine was indistinguishable from one working perfectly. (#42)
- **Your node's diagnostic logs are NOT sent, unless you say so.** Log lines carry free text: a failed git
  operation quotes the remote it could not reach, the branch it was on, and the paths it was working with.
  So log shipping is **off** for any node running on hardware you operate, and the hub refuses your log
  records even if a client sends them anyway. You can enable it deliberately, and disable it again.

  Nodes running on Dahrk-operated infrastructure do ship their logs, because we operate those machines and
  need them to run the service. (#42)
- **`DAHRK_TELEMETRY` is a ceiling the hub cannot raise.** `off` sends nothing at all about the node;
  `health` permits the health report and refuses log shipping however nicely the hub asks. The hub may only
  ever ask for *less* than you allow, never more.

  This client is open source and you can read `log-shipper.ts` yourself, which is rather the point: a hub
  that could override a local opt-out would be a claim anyone could catch us breaking. (#42)
- An operator can turn a running node's log shipping up for a session while debugging it, **without
  restarting it** - restarting a misbehaving node destroys the state you were trying to look at. It reverts
  to the node's own default when it reconnects, so a debugging act cannot quietly become a standing
  setting. (#42)

### Changed

- **A tool's result is no longer clipped mid-sentence, and no longer lands against the wrong tool.**
  Progress frames carried a tool call and its result as two adjacent items with nothing tying them
  together, so the hub had to pair them by adjacency. That holds only while tools run strictly one at a
  time: the moment a stage runs tools in parallel, or a tool's result comes back deferred, the frames
  interleave and a result gets attributed to whichever call happened to precede it. You would read a
  file's contents underneath a search you never ran.

  Each `action` and `observation` now carries the tool-use id it belongs to, so a result is matched to
  its call by identity rather than by luck of ordering. Result output also gets its own budget of 16,000
  characters instead of sharing the 500-character preview budget used for noisy intermediate steps,
  which was clipping real content a human was meant to read. Output beyond that ceiling is still
  truncated on the wire, deliberately, to keep a whole-repo grep off the control socket - the full
  output survives in the trace archive either way. (#44)

### Fixed

- **`dahrk stop` no longer reports success while a node keeps running.** `stop` drives the service it
  installed (launchd / systemd), and it cannot stop a node somebody else supervises: one started under
  pm2, in a container, or with `dahrk start --foreground` in another terminal. It used to print "Node
  stopped." regardless, so a pm2-supervised node went on holding this host's identity and taking Jobs
  from the hub while the operator had every reason to believe the host was idle. `stop` now checks the
  single-instance pidfile after stopping the service, names the surviving node's pid, says where to go
  and stop it, and exits 3 rather than 0. (#43)
- **A node exiting no longer deletes another node's lock.** `release()` removed the pidfile
  unconditionally, so a node that had reclaimed a stale lock (or lost the acquire race) would, on its way
  out, delete the pidfile of the live node that had since taken it. That left the single-instance guard
  silently disarmed - the exact condition it exists to prevent - and left `dahrk stop` nothing on disk to
  find the surviving node by. Release now removes the pidfile only while it still names the releasing
  process. (#43)

## [0.1.9] - 2026-07-11

### Fixed

- **A node no longer destroys the branch of a run that is still in flight, and no longer wedges every
  re-run of an issue.** Three defects in the worktree/mirror layer interacted (#39):

  - The per-repo cache was a `git clone --mirror`, whose refspec force-syncs local refs to match the
    remote on every fetch. A run's branch exists only locally until `deliver` pushes it (and the forge
    deletes the branch again on merge), so **every mirror refresh deleted the branch of any run then in
    flight**, orphaning its commits and leaving the worktree on an unborn HEAD. The mirror now keeps the
    remote's refs under `refs/remotes/origin/*` and the node's own run branches under `refs/heads/*`,
    which a fetch never touches. Existing mirrors migrate themselves in place on the next refresh; there
    is nothing to do and nothing to re-clone.
  - Run worktrees were **never removed**. Teardown only ran if you had configured a retention policy, and
    even then it only knew about runs the current process had started, so anything from a previous
    process was orphaned for good. One node reached 92 worktrees and 65 GB. There is now a reaper that
    reconciles what is actually on disk, runs at startup and after each stage, and has sane defaults -
    "no policy configured" no longer means "never collect anything". It never touches a run that is busy.
  - A worktree left behind by an earlier run went on **claiming its branch name for ever**, so the next
    run of the same issue failed outright with `fatal: '<branch>' is already used by worktree at...`.
    Stale claims are now cleared before a worktree is created, and a run is always based on the current
    remote base rather than on whatever a previous run happened to leave behind. If work would be
    discarded, its tip is first parked under `refs/dahrk/salvage/` rather than dropped.

  Tune the reaper with `DAHRK_RETENTION_MAX_RUNS` / `DAHRK_RETENTION_MAX_AGE_MS`, or preview a sweep with
  `DAHRK_REAPER_DRY_RUN=1`.

### Changed

- **`dahrk start` now means "make this node run, and keep it running".** It installs the always-on
  service, starts it, and hands your terminal back, instead of blocking forever. Nodes are meant to be
  always-on, so that is what the plain verb should do. The blocking worker is still there and is still a
  first-class way to run a node - it is now `dahrk start --foreground` (or `DAHRK_FOREGROUND=1`), which is
  what you want in a container, under pm2, in CI, or to watch a node work. `--ephemeral` implies it.

  **If you run a node under pm2 or in a container, add `--foreground`** (the bundled `ecosystem.config.cjs`
  already does). Everything else upgrades on its own: an installed service repairs its own unit the first
  time it restarts. (#38)

### Added

- **The node keeps a proper log now, and it is written at `debug` whether or not you asked for it.** It had
  no logger at all before: bare lines on stdout, with no levels, no timestamps, and nothing kept. An
  incident on a node left nothing behind to read.

  There are now two logs. The transcript (`node.out.log` / `node.err.log`) is unchanged - the same lines,
  as printed. Alongside it, `~/.dahrk/logs/node.jsonl` holds the structured record: level, timestamp,
  correlation ids, and full error stacks, rotated at 10 MB across five generations.

  The important part is that **the file is written at `debug` even when your terminal is not.**
  `DAHRK_LOG_LEVEL` (default `info`) governs only what reaches stdout. Debug logging you have to switch on
  *before* the incident is no use, because you find out you wanted it *afterwards* - so the node always
  writes the detail, and the evidence for a failure is already on disk by the time you go looking. At
  `debug` you also see every git operation: clone, mirror refresh, worktree create, fetch. (#40)
- **`dahrk logs --run <runId>`**, plus `--level` and `--json`. Every line the node writes during a stage
  carries the same identifiers the hub knows that run by, so a node's account of a run and the hub's are
  finally the same story told from two ends. A bare `dahrk logs` still tails the transcript exactly as
  before. (#40)
- **`dahrk diagnose`** - a support bundle you can actually read. It collects this node's identity, version
  and host, the `doctor` verdict, the tail of the structured log, and every crash record, and writes them
  to **one local JSON file**. It uploads nothing, and there is no flag to make it. The enrolment token is
  removed rather than redacted, and no source, prompts or issue content go in.

  This is deliberate. Debugging a node running on someone else's machine means asking them for it, and the
  point of the bundle is that saying yes is safe: they can open it, read every byte, and decide. (#40)
- A crash now leaves something behind. Uncaught exceptions and unhandled rejections are logged with a full
  stack and written to `~/.dahrk/logs/crashes/<timestamp>.json`, and the node carries on rather than dying
  (set `DAHRK_CRASH_EXIT=1` if you would rather your supervisor restart it). The crash record is a separate
  file from the log on purpose: the log rotates, and a crash-loop will happily push its own first cause out
  of it. (#40)
- `dahrk stop`, `dahrk restart`, and `dahrk logs [-f] [-n <lines>]`. `stop` was previously
  `unknown command: stop` - the only way to stop a node was `dahrk service uninstall`, which also removed
  it. A stopped node stays stopped across reboots until the next `start`, and `dahrk status` now tells a
  node you stopped **on purpose** from one that is **crash-looping**, exiting non-zero only for the latter
  so it remains usable as a health check. (#38)
- The node tells you when its client is out of date, rather than waiting to be asked - an always-on node
  is started once and then runs for months, so it never otherwise finds out. `dahrk start` offers to
  update (only at a terminal - a scripted start never blocks on a prompt), the running node logs
  `UPDATE_AVAILABLE:<version>` once a day, and `dahrk status` reports it. Nothing ever updates itself; run
  `dahrk update` when you want it. The check reads the registry at most once a day and fails silently when
  it cannot (it can never delay or fail a start). Switch it off with `DAHRK_NO_UPDATE_CHECK=1`,
  `NO_UPDATE_NOTIFIER`, or `CI`. (#38)

### Fixed

- **Git was completely silent.** The worktree layer has always had a logging seam, with something useful to
  say on every clone, mirror refresh and worktree create - but nothing was ever plugged into it, so it
  discarded every line. On a real node, no git operation has ever been logged. They are now, at `debug`,
  which is exactly what you want when a stage fails before the agent even starts. (#40)
- Credentials could reach a log line. Now that the node logs git output and agent errors, the log itself
  becomes somewhere a token could land - a git failure will happily echo the remote URL it failed on,
  credentials and all. Everything written to a log is scrubbed first: values under sensitive keys,
  credentials embedded in URLs (`https://user:secret@host`), and token-shaped strings anywhere in free text.
  It errs on the side of dropping: a redacted value costs you a re-run, a leaked token rather more. (#40)
- Failures on the node's best-effort paths vanished without trace. The worst of them: if shipping a stage's
  final trace to the hub failed, the hub simply ended up with **no trace for that stage** - the whole record
  of what the agent did - and nobody ever found out why. These paths are still best-effort and still never
  fatal; they are just no longer silent. (#40)
- A node piped into a command that exits first (`dahrk start | head`) would write spurious crash records.
  Closing the pipe made the next write raise `EPIPE`, which surfaced as an uncaught exception, which the
  crash handler then tried to log through the very output that had just gone away. A logger must never be
  the cause of a crash. (#40)
- The containerised Pi runtime could hang. Its error output was piped and then never read, so a container
  with much to say would fill the pipe buffer and block on its next write - with the explanation for the
  stall sitting unread in the pipe. (#40)
- Two nodes could run at once on the same machine - `dahrk service install` followed by `dahrk start` in a
  terminal was enough. Because a node's id is persisted and re-presented on every dial, that is not two
  nodes: it is one node dialling the hub twice and racing itself for the Jobs it is given. A node now takes
  a lock (`~/.dahrk/node.pid`) and a second one refuses to start. A node killed outright releases it, so a
  crash cannot lock the host out. (#38)
- Linux nodes logged only to the journal, so there was no single answer to "where are the logs". The
  systemd unit now writes the same `~/.dahrk/logs/node.{out,err}.log` that launchd always has, and
  `dahrk logs` reads them on every platform. They are rotated past 10 MB, keeping one generation. (#38)
- `dahrk status` pointed at a log path that ignored `DAHRK_STATE_DIR`, so a node with a custom state
  directory was told to tail a file that would never exist. There is now one definition of the log
  directory. (#38)

## [0.1.8] - 2026-07-11

### Added

- `dahrk status`: is this node enrolled (and as whom), what runtimes can it serve, and is the
  always-on service actually running? It answers locally and dials nothing, so it is instant and works
  offline - `doctor` remains the one that checks the hub is reachable and the token still valid. It
  calls out the state that was previously invisible: a service that is installed but *not running*
  (crash-looping or failing to load), and exits non-zero for it so it can be used as a health check.
  (#36)

### Fixed

- The service unit was world-readable (`0644`) and holds your enrolment token in its environment
  block. `dahrk service install` now writes it `0600`, and re-installing tightens the mode on a unit an
  older client left readable. If you installed the service before this release, re-run
  `dahrk service install` to fix the file already on disk. (#36)
- The installed service pointed at a *versioned* Node path (e.g.
  `/opt/homebrew/Cellar/node/26.5.0/bin/node`, which is what `process.execPath` reports for a Homebrew
  Node). The next `brew upgrade node` deletes that directory, so the node would silently stop serving
  Jobs and crash-loop every 10 seconds forever. The unit now prefers a stable path that resolves to the
  same binary (`/opt/homebrew/opt/node/bin/node`), verified rather than assumed. Re-run
  `dahrk service install` to repin an already-installed service. (#36)
- Enrolment did not survive a restart. `dahrk start --token <token>` enrolled and ran, but the token
  was never saved, so the moment you stopped the node a plain `dahrk start` died with
  `EDGE_REJECTED:4400 an enrolment token is required` - every reboot, service restart, and update
  meant pasting the token again (or exporting `DAHRK_ENROL_TOKEN` by hand). A token the hub accepts
  is now cached alongside the node id in `~/.dahrk/node.json` (owner-only, `0600`), so enrolment is a
  one-time act and later runs re-attach as the same node with no token. `doctor`, `run`, and
  `service install` use the cached token too. Pass `--token` again to re-enrol with a rotated token,
  and `--ephemeral` still keeps everything off disk. Only a token the hub has actually welcomed is
  cached, so a typo is never written. (#36)

## [0.1.7] - 2026-07-11

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

[Unreleased]: https://github.com/dahrkai/dahrk-node/compare/v0.1.15...HEAD
[0.1.15]: https://github.com/dahrkai/dahrk-node/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/dahrkai/dahrk-node/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/dahrkai/dahrk-node/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/dahrkai/dahrk-node/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/dahrkai/dahrk-node/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/dahrkai/dahrk-node/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/dahrkai/dahrk-node/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/dahrkai/dahrk-node/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/dahrkai/dahrk-node/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/dahrkai/dahrk-node/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/dahrkai/dahrk-node/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/dahrkai/dahrk-node/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/dahrkai/dahrk-node/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/dahrkai/dahrk-node/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/dahrkai/dahrk-node/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dahrkai/dahrk-node/releases/tag/v0.1.0
