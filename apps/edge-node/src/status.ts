/**
 * `dahrk status` - what is this node, right now? The question an operator asks between `install` and
 * "why is nothing running", and the one the CLI could not answer: you had to read `~/.dahrk/node.json`,
 * `launchctl list`, and a log file yourself.
 *
 * It is a LOCAL report and deliberately does no network: it answers from the state file and the
 * supervisor, so it works on a plane and never hangs on a dead hub. Reachability and token validity are
 * `dahrk doctor`'s job (it dials); `status` tells you what is installed, enrolled, and up. The split is
 * the point - `status` is the cheap one you run first.
 *
 * The report builder is pure (it takes gathered facts and returns lines), so it unit-tests without a
 * host, a supervisor, or a state file; `runStatus` is the thin IO shell.
 */
import type { Runtime } from "@dahrk/contracts";
import { detectManager, parseServiceStatus, statusCommand, unitPath, type ServiceStatus } from "./service.js";
import { readState, stateFile, type NodeState } from "./state.js";
import { cachedUpdate, checkSuppressed, type UpdateAvailable } from "./update-check.js";

/** Everything `status` reports, gathered before any of it is formatted. */
export interface StatusFacts {
  clientVersion: string;
  hubUrl: string;
  stateFile: string;
  state: NodeState;
  runtimes: Runtime[];
  /** True when `DAHRK_ENROL_TOKEN` is set in the environment. A node can hold a token without having
   *  cached one (the service unit supplies it via its env block, and a client older than the cache
   *  never wrote one), so "no cached token" alone would wrongly read as "not enrolled". */
  envToken: boolean;
  /** Absent when the host has no supervisor we drive (Windows), where "installed" is meaningless. */
  service?: ServiceStatus;
  logHint?: string;
  /** A newer client, as of the last time anything checked. Read from the state file, never fetched - see
   *  the module note about staying offline. */
  update?: UpdateAvailable;
}

const bullet = (label: string, value: string): string => `  ${label.padEnd(12)}${value}`;

/** Render the report. Pure. Ordered by the question an operator actually asks, in order: am I enrolled,
 *  is the service up, can I serve a Job. */
export function renderStatus(f: StatusFacts): string[] {
  const lines: string[] = ["dahrk status", ""];

  // Enrolment. The token is a secret and is never printed - not even a prefix; that it exists is the
  // fact worth reporting, and a partial token is still a partial token in a screenshot.
  const { nodeId, name, tenantId, enrolToken } = f.state;
  if (enrolToken) {
    lines.push(bullet("Enrolled", name ? `yes, as ${name}` : "yes"));
    if (tenantId) lines.push(bullet("Tenant", tenantId));
  } else if (f.envToken) {
    // A token from the environment (or the service unit's env block) works, but is not yet cached, so
    // a bare `dahrk start` in a shell without it would still fail. Say so rather than claim "enrolled".
    lines.push(bullet("Enrolled", "yes, via DAHRK_ENROL_TOKEN (caches on the next successful start)"));
  } else {
    lines.push(bullet("Enrolled", "no - run `dahrk start --token <token>` once to enrol"));
  }
  lines.push(bullet("Node id", nodeId ?? "not yet minted (first `dahrk start` mints one)"));
  // An always-on node is started once and then runs for months, so this line is the main place anyone will
  // ever find out it is stale. Reported from the cache the last check wrote, so `status` stays offline.
  lines.push(
    bullet(
      "Client",
      f.update
        ? `${f.clientVersion} (update available: ${f.update.latest} - run \`dahrk update\`)`
        : f.clientVersion,
    ),
  );
  lines.push(bullet("Hub", f.hubUrl));

  // Runtimes: a node with none connects but serves no Jobs, which looks like a hub problem and is not.
  lines.push(
    bullet(
      "Runtimes",
      f.runtimes.length > 0
        ? f.runtimes.join(", ")
        : "none detected - this node will serve no Jobs (install claude / codex / pi)",
    ),
  );

  // The node. A unit that is installed but not running means one of two completely different things, and
  // the difference is not something the supervisor can tell us: either the operator ran `dahrk stop` (fine,
  // nothing to report) or it is failing to start and crash-looping (bad, and invisible unless you go
  // looking). `desired` is what disambiguates them - it is why we record intent at all.
  if (!f.service) {
    lines.push(bullet("Node", "no supervisor on this host - run `dahrk start --foreground` (or under pm2)"));
  } else if (!f.service.installed) {
    lines.push(bullet("Node", "not installed - run `dahrk start` to run it always-on"));
  } else if (f.service.running) {
    const pid = f.service.pid ? ` (pid ${f.service.pid})` : "";
    lines.push(bullet("Node", `running${pid}`));
  } else if (f.state.desired === "stopped") {
    lines.push(bullet("Node", "stopped - run `dahrk start` to bring it back"));
  } else {
    lines.push(bullet("Node", "INSTALLED BUT NOT RUNNING - it is failing to start or crash-looping"));
    if (f.logHint) lines.push(bullet("", `check the logs: ${f.logHint}`));
  }

  lines.push("", `State file: ${f.stateFile}`);
  return lines;
}

/** Is anything actually wrong? Only the crash-loop is: a node nobody has installed yet, and a node the
 *  operator deliberately stopped, are both working as intended. This is what makes `dahrk status` usable as
 *  a health check in a script - it must not cry wolf over a node someone stopped on purpose. */
export function isUnhealthy(f: Pick<StatusFacts, "service" | "state">): boolean {
  return Boolean(f.service?.installed && !f.service.running && f.state.desired !== "stopped");
}

/** Injectable IO so the shell tests without a host, a supervisor, or a real state file. */
export interface StatusDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  /** This client's bin path, used only to name the install channel in the update notice (npm / Homebrew). */
  binPath?: string;
  detectRuntimes: () => Promise<Runtime[]>;
  fileExists: (path: string) => boolean;
  /** Run a probe and capture its output (never inherits stdio: its text is parsed, not shown). */
  capture: (argv: string[]) => { code: number; stdout: string };
  out: (line: string) => void;
}

/**
 * Gather the facts and print the report. Exit 0 when there is nothing wrong, 1 when the service is
 * installed but not running - the one state that is unambiguously broken, so `dahrk status` is usable
 * as a health check in a script. Not being enrolled or not having the service installed are not
 * failures: they are just things you have not done yet.
 */
export async function runStatus(
  inputs: { clientVersion: string; hubUrl: string },
  deps: StatusDeps,
): Promise<number> {
  const manager = detectManager(deps.platform);
  let service: ServiceStatus | undefined;
  let logHint: string | undefined;
  if (manager !== "unsupported") {
    const unit = unitPath(manager, deps.homeDir);
    const exists = deps.fileExists(unit);
    // Only ask the supervisor when the unit is actually there: `launchctl list` on an unknown label is
    // a non-zero exit we would otherwise have to special-case, and spawning at all is wasted work.
    const probe = exists ? deps.capture(statusCommand(manager)) : { code: 1, stdout: "" };
    service = parseServiceStatus(manager, exists, probe);
    // One hint on every platform, because both supervisors now write the same log files.
    logHint = "dahrk logs -f";
  }

  const state = readState(stateFile(deps.env));
  // From the CACHE, never a fetch: `status` is the command you run on a plane, and it stays that way.
  const update = checkSuppressed(deps.env)
    ? undefined
    : cachedUpdate(state, inputs.clientVersion, deps.binPath);

  const facts: StatusFacts = {
    clientVersion: inputs.clientVersion,
    hubUrl: inputs.hubUrl,
    stateFile: stateFile(deps.env),
    state,
    envToken: Boolean(deps.env.DAHRK_ENROL_TOKEN),
    runtimes: await deps.detectRuntimes(),
    ...(service ? { service } : {}),
    ...(logHint ? { logHint } : {}),
    ...(update ? { update } : {}),
  };
  for (const line of renderStatus(facts)) deps.out(line);

  return isUnhealthy(facts) ? 1 : 0;
}
