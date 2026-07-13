/**
 * `dahrk status` - what is this node, right now? The question an operator asks between `install` and
 * "why is nothing running", and the one the CLI could not answer: you had to read `~/.dahrk/node.json`,
 * `launchctl list`, and a log file yourself.
 *
 * It is a LOCAL report and deliberately does no network: it answers from the state file, the supervisor, the
 * pidfile, the job ledger and the log, so it works on a plane and never hangs on a dead hub. Reachability
 * and token validity are `dahrk doctor`'s job (it dials); `status` tells you what is installed, enrolled, up
 * and busy. The split is the point - `status` is the cheap one you run first.
 *
 * Being offline forces one piece of discipline, and it is worth naming. The node's live connection state
 * exists only inside the running daemon (it is sent to the hub on each heartbeat and never written down), so
 * this command CANNOT truthfully print "connected". What it can do is read the timestamped `EDGE_CONNECTED` /
 * `EDGE_WELCOMED` / `EDGE_DISCONNECTED` markers the node leaves in `node.jsonl` and report the last thing
 * that was known to be true, said as such: "welcomed 2h ago", not "connected". A status line that quietly
 * guesses is worse than one that admits what it does not know.
 *
 * This is also the canonical view of a node: `start`, `stop` and `restart` all end by rendering it, so
 * "what happened" and "what is true now" are answered by the same block of text rather than by three
 * hand-rolled summaries that drifted apart.
 *
 * The report builder is pure (it takes gathered facts and returns lines), so it unit-tests without a host, a
 * supervisor, or a state file; `gatherFacts` is the IO half, and `runStatus` is the thin shell that joins
 * them.
 */
import type { JobLedgerEntry, RuntimeStatus } from "@dahrk/edge";
import { detectManager, parseServiceStatus, statusCommand, unitPath, type ServiceStatus } from "./service.js";
import { readState, stateFile, type NodeState } from "./state.js";
import { ago, dim, hints, humanDuration, kv, verdict, type Level } from "./ui.js";
import { cachedUpdate, checkSuppressed, type UpdateAvailable } from "./update-check.js";

/** How the node is running, which is a richer question than "is the unit up". `foreign` is a node this
 *  client did not supervise - `dahrk start --foreground`, pm2, a container - which is a perfectly healthy
 *  node that `status` used to report as "not installed", because it only ever asked launchd. */
export type NodePresence =
  | { kind: "running"; pid?: number }
  | { kind: "foreign"; pid: number }
  | { kind: "stopped" }
  | { kind: "not-installed" }
  | { kind: "crashed" }
  | { kind: "no-supervisor" };

/** The last thing the node's log says about its connection to the hub. Read from `node.jsonl`, never
 *  probed - see the module note on why this is deliberately a last-known fact and not a live one. */
export interface ConnectionFact {
  /** The marker's own verb: `connected`, `welcomed`, `disconnected`, `stale`. */
  event: string;
  /** Epoch ms the marker was written. */
  at: number;
  /** Trailing detail, e.g. a disconnect's close code. */
  detail?: string;
}

/** Everything `status` reports, gathered before any of it is formatted. */
export interface StatusFacts {
  clientVersion: string;
  hubUrl: string;
  stateFile: string;
  state: NodeState;
  /** Every candidate runtime with its version, not just the installed names: `doctor` already paid for this
   *  probe and `status` used to throw the versions away. */
  runtimes: RuntimeStatus[];
  /** True when `DAHRK_ENROL_TOKEN` is set in the environment. A node can hold a token without having
   *  cached one (the service unit supplies it via its env block, and a client older than the cache
   *  never wrote one), so "no cached token" alone would wrongly read as "not enrolled". */
  envToken: boolean;
  presence: NodePresence;
  /** Jobs this node is running right now, from its on-disk ledger. Already filtered to the live process:
   *  an entry owned by a dead pid is a leftover for boot to reconcile, not work in flight. */
  jobs: JobLedgerEntry[];
  /** Absent when the host has no supervisor we drive (Windows), where "installed" is meaningless. */
  service?: ServiceStatus;
  connection?: ConnectionFact;
  /** A newer client, as of the last time anything checked. Read from the state file, never fetched - see
   *  the module note about staying offline. */
  update?: UpdateAvailable;
  /** Now, injected so the renderer stays pure and elapsed times are testable. */
  now: number;
}

/** The single-line verdict, and the exit code it implies. The first line of the report, because it is the
 *  answer: everything under it is the working. */
function presenceVerdict(f: StatusFacts): { level: Level; text: string } {
  switch (f.presence.kind) {
    case "running": {
      const pid = f.presence.pid ? ` (pid ${f.presence.pid})` : "";
      return { level: "ok", text: `Node running${pid}` };
    }
    case "foreign":
      return { level: "ok", text: `Node running under another supervisor (pid ${f.presence.pid})` };
    case "stopped":
      return { level: "warn", text: "Node stopped" };
    case "not-installed":
      return { level: "warn", text: "Node not installed" };
    case "crashed":
      return { level: "fail", text: "Node is installed but NOT running - it is failing to start or crash-looping" };
    case "no-supervisor":
      return { level: "warn", text: "No supervisor on this host" };
  }
}

/** The next-step hints for a given presence. What `git status` does, and the reason it is the CLI everyone
 *  cites: the report tells you what is true, then tells you what to type next. */
function presenceHints(f: StatusFacts): string[] {
  switch (f.presence.kind) {
    case "running":
    case "foreign":
      return [hints([["logs", "dahrk logs -f"], ["stop", "dahrk stop"]])];
    case "stopped":
      return [hints([["start", "dahrk start"]])];
    case "not-installed":
      return [hints([["start", "dahrk start"]])];
    case "crashed":
      return [hints([["logs", "dahrk logs -f"], ["check", "dahrk doctor"], ["report", "dahrk diagnose"]])];
    case "no-supervisor":
      return [hints([["run it here", "dahrk start --foreground"]])];
  }
}

/** Render the report. Pure. Ordered by the question an operator actually asks, in order: is it up, who am I,
 *  can I serve a Job, what am I doing. */
export function renderStatus(f: StatusFacts): string[] {
  const v = presenceVerdict(f);
  const lines: string[] = ["", verdict(v.level, v.text), ""];

  // Enrolment. The token is a secret and is never printed - not even a prefix; that it exists is the
  // fact worth reporting, and a partial token is still a partial token in a screenshot.
  const { nodeId, name, tenantId, enrolToken } = f.state;
  if (enrolToken) {
    const who = name ? name : "yes";
    lines.push(kv("Enrolled", tenantId ? `${who}  ${dim("·")}  ${tenantId}` : who));
  } else if (f.envToken) {
    // A token from the environment (or the service unit's env block) works, but is not yet cached, so
    // a bare `dahrk start` in a shell without it would still fail. Say so rather than claim "enrolled".
    lines.push(kv("Enrolled", "via DAHRK_ENROL_TOKEN (caches on the next successful start)"));
  } else {
    lines.push(kv("Enrolled", `no  ${dim("run `dahrk start --token <token>` once to enrol")}`));
  }
  lines.push(kv("Node id", nodeId ?? dim("not yet minted (first `dahrk start` mints one)")));

  // An always-on node is started once and then runs for months, so this line is the main place anyone will
  // ever find out it is stale. Reported from the cache the last check wrote, so `status` stays offline.
  lines.push(
    kv(
      "Client",
      f.update
        ? `${f.clientVersion}  ${dim(`(update available: ${f.update.latest} - run \`dahrk update\`)`)}`
        : f.clientVersion,
    ),
  );

  // The hub we WOULD dial, plus the last thing we actually know about that connection. Never "connected":
  // see the module note. A node that has never connected has no marker, and says nothing rather than lying.
  const conn = f.connection
    ? `  ${dim(`(${f.connection.event} ${ago(f.now - f.connection.at)}${f.connection.detail ? `, ${f.connection.detail}` : ""})`)}`
    : "";
  lines.push(kv("Hub", `${f.hubUrl}${conn}`));

  // Runtimes: a node with none connects but serves no Jobs, which looks like a hub problem and is not.
  const installed = f.runtimes.filter((r) => r.installed);
  lines.push(
    kv(
      "Runtimes",
      installed.length > 0
        ? installed.map((r) => (r.version ? `${r.runtime} ${dim(r.version)}` : r.runtime)).join(", ")
        : `${dim("none detected - this node will serve no Jobs (install claude / codex / pi)")}`,
    ),
  );

  // What it is doing. The ledger is written for crash recovery, but it is also the only honest answer to
  // "is this node busy?" available without dialling the hub - and it is the thing you want to know before
  // you restart it.
  if (f.jobs.length === 0) {
    lines.push(kv("Work", dim("idle")));
  } else {
    const [first, ...rest] = f.jobs;
    lines.push(kv("Work", jobLine(first as JobLedgerEntry, f.now)));
    for (const j of rest) lines.push(kv("", jobLine(j, f.now)));
  }

  lines.push(...presenceHints(f).flatMap((h) => ["", h]));
  lines.push("", dim(`  State file: ${f.stateFile}`));
  return lines;
}

/** One in-flight job: where it is, and how long it has been there. */
function jobLine(j: JobLedgerEntry, now: number): string {
  const where = j.stageId ? `${j.runId} ${dim("/")} ${j.stageId}` : `${j.runId} ${dim(`(${j.kind})`)}`;
  return `${where}  ${dim(humanDuration(now - j.startedAt))}`;
}

/** Is anything actually wrong? Only the crash-loop is: a node nobody has installed yet, and a node the
 *  operator deliberately stopped, are both working as intended. This is what makes `dahrk status` usable as
 *  a health check in a script - it must not cry wolf over a node someone stopped on purpose. */
export function isUnhealthy(f: Pick<StatusFacts, "presence">): boolean {
  return f.presence.kind === "crashed";
}

/** Injectable IO so the shell tests without a host, a supervisor, or a real state file. */
export interface StatusDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  /** This client's bin path, used only to name the install channel in the update notice (npm / Homebrew). */
  binPath?: string;
  /** Every runtime with its version. `doctor`'s probe, not the thin installed-set view `status` used to use:
   *  same spawn cost, strictly more to report. */
  probeRuntimes: () => Promise<RuntimeStatus[]>;
  fileExists: (path: string) => boolean;
  /** Run a probe and capture its output (never inherits stdio: its text is parsed, not shown). */
  capture: (argv: string[]) => { code: number; stdout: string };
  /** The pid holding the single-instance pidfile, if that process is still alive. The WORKER takes the lock
   *  whoever supervises it, so this is what makes a foreground / pm2 / container node visible to `status` at
   *  all - asking only launchd is what made a perfectly healthy foreground node report as "not installed". */
  lockedPid: () => number | undefined;
  /** What the node is running, from `~/.dahrk/jobs.json`. */
  jobs: () => JobLedgerEntry[];
  /** The last connection marker in `node.jsonl`, if any. */
  connection: () => ConnectionFact | undefined;
  now: () => number;
  out: (line: string) => void;
}

/** Work out how the node is present on this host. Both sources are consulted, and they disagree in exactly
 *  the case that matters: the supervisor knows nothing about a node started any other way. */
export function resolvePresence(
  service: ServiceStatus | undefined,
  lockedPid: number | undefined,
  desired: NodeState["desired"],
): NodePresence {
  if (service?.running) return { kind: "running", ...(service.pid ? { pid: service.pid } : {}) };
  // Not up under our supervisor, but something holds the lock: a real node, just not one we started.
  if (lockedPid !== undefined) return { kind: "foreign", pid: lockedPid };
  if (!service) return { kind: "no-supervisor" };
  if (!service.installed) return { kind: "not-installed" };
  // Installed, not running, and nobody asked for that: it is failing to start or crash-looping. `desired` is
  // what disambiguates it from a node the operator deliberately stopped - it is why we record intent at all.
  return desired === "stopped" ? { kind: "stopped" } : { kind: "crashed" };
}

/** Gather every fact the report needs. The IO half, so `renderStatus` can stay pure and `start` / `stop` /
 *  `restart` can reuse both halves without re-implementing either. */
export async function gatherFacts(
  inputs: { clientVersion: string; hubUrl: string },
  deps: StatusDeps,
): Promise<StatusFacts> {
  const manager = detectManager(deps.platform);
  let service: ServiceStatus | undefined;
  if (manager !== "unsupported") {
    const unit = unitPath(manager, deps.homeDir);
    const exists = deps.fileExists(unit);
    // Only ask the supervisor when the unit is actually there: `launchctl list` on an unknown label is
    // a non-zero exit we would otherwise have to special-case, and spawning at all is wasted work.
    const probe = exists ? deps.capture(statusCommand(manager)) : { code: 1, stdout: "" };
    service = parseServiceStatus(manager, exists, probe);
  }

  const state = readState(stateFile(deps.env));
  const lockedPid = deps.lockedPid();
  const presence = resolvePresence(service, lockedPid, state.desired);

  // Only jobs owned by the process that is actually running. An entry whose `nodePid` is anybody else's was
  // left behind by a node that died, and the next boot reconciles it; showing it as live work would be a
  // report of something that is not happening.
  const livePid = presence.kind === "running" || presence.kind === "foreign" ? presence.pid : undefined;
  const jobs = livePid === undefined ? [] : deps.jobs().filter((j) => j.nodePid === livePid);

  // From the CACHE, never a fetch: `status` is the command you run on a plane, and it stays that way.
  const update = checkSuppressed(deps.env)
    ? undefined
    : cachedUpdate(state, inputs.clientVersion, deps.binPath);
  const connection = deps.connection();

  return {
    clientVersion: inputs.clientVersion,
    hubUrl: inputs.hubUrl,
    stateFile: stateFile(deps.env),
    state,
    envToken: Boolean(deps.env.DAHRK_ENROL_TOKEN),
    runtimes: await deps.probeRuntimes(),
    presence,
    jobs,
    now: deps.now(),
    ...(service ? { service } : {}),
    ...(connection ? { connection } : {}),
    ...(update ? { update } : {}),
  };
}

/** The connection markers the node writes, and the verb each one means. Matched against the tail of
 *  `node.jsonl`; the marker format (`EDGE_DISCONNECTED:1006`) is the node's own stdout contract.
 *
 *  `detail` says whether the marker's tail is worth showing. A disconnect's tail is a close code, which is
 *  the first thing you want; a welcome's tail is the whole policy payload (name, tenant, credential mode),
 *  which is already on the lines above and would swamp the line it sits on. */
const CONNECTION_MARKERS: ReadonlyArray<{ prefix: string; event: string; detail: boolean }> = [
  { prefix: "EDGE_WELCOMED", event: "welcomed", detail: false },
  { prefix: "EDGE_CONNECTED", event: "connected", detail: false },
  { prefix: "EDGE_DISCONNECTED", event: "disconnected", detail: true },
  { prefix: "EDGE_STALE", event: "went stale", detail: false },
];

/** Find the most recent connection marker in a parsed log. Pure, so it tests without a log file. */
export function lastConnection(
  records: Array<{ msg?: unknown; time?: unknown }>,
): ConnectionFact | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (typeof r?.msg !== "string") continue;
    const marker = CONNECTION_MARKERS.find((m) => r.msg === m.prefix || (r.msg as string).startsWith(`${m.prefix}:`));
    if (!marker) continue;
    const at = typeof r.time === "string" ? Date.parse(r.time) : typeof r.time === "number" ? r.time : NaN;
    if (Number.isNaN(at)) continue;
    // Only the first token: a close code is `1006`, not `1006 going away because ...`.
    const detail = marker.detail ? (r.msg.slice(marker.prefix.length + 1).split(/\s+/)[0] ?? "") : "";
    return { event: marker.event, at, ...(detail ? { detail } : {}) };
  }
  return undefined;
}

/**
 * Gather the facts and print the report. Exit 0 when there is nothing wrong, 1 when the node is installed
 * but not running and nobody asked for that - the one state that is unambiguously broken, so `dahrk status`
 * is usable as a health check in a script. Not being enrolled or not having the service installed are not
 * failures: they are just things you have not done yet.
 *
 * `--json` prints the facts and nothing else, so the same command serves a human and a monitoring script
 * without either having to parse the other's output.
 */
export async function runStatus(
  inputs: { clientVersion: string; hubUrl: string; json?: boolean },
  deps: StatusDeps,
): Promise<number> {
  const facts = await gatherFacts(inputs, deps);

  if (inputs.json) {
    // The token is a secret even here: a status blob is exactly the kind of thing that gets pasted into an
    // issue. Everything else about the state is fair game.
    const { enrolToken: _omitted, ...state } = facts.state;
    deps.out(JSON.stringify({ ...facts, state, healthy: !isUnhealthy(facts) }, null, 2));
    return isUnhealthy(facts) ? 1 : 0;
  }

  for (const line of renderStatus(facts)) deps.out(line);
  return isUnhealthy(facts) ? 1 : 0;
}
