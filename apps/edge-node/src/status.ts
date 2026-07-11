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
  lines.push(bullet("Client", f.clientVersion));
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

  // Service. installed-but-not-running is the state worth shouting about: it means the supervisor has
  // the unit and is failing to keep it up (a crash-loop), which is invisible unless you go looking.
  if (!f.service) {
    lines.push(bullet("Service", "not supported on this host (run `dahrk start` under pm2 instead)"));
  } else if (!f.service.installed) {
    lines.push(bullet("Service", "not installed - run `dahrk service install` to run on boot"));
  } else if (f.service.running) {
    const pid = f.service.pid ? ` (pid ${f.service.pid})` : "";
    lines.push(bullet("Service", `running${pid}`));
  } else {
    lines.push(bullet("Service", "INSTALLED BUT NOT RUNNING - it is failing to start or crash-looping"));
    if (f.logHint) lines.push(bullet("", `check the logs: ${f.logHint}`));
  }

  lines.push("", `State file: ${f.stateFile}`);
  return lines;
}

/** Injectable IO so the shell tests without a host, a supervisor, or a real state file. */
export interface StatusDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  env: NodeJS.ProcessEnv;
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
    logHint =
      manager === "launchd"
        ? `tail -f ${deps.homeDir}/.dahrk/logs/node.err.log`
        : "journalctl --user -u dahrk-node.service -f";
  }

  const facts: StatusFacts = {
    clientVersion: inputs.clientVersion,
    hubUrl: inputs.hubUrl,
    stateFile: stateFile(deps.env),
    state: readState(stateFile(deps.env)),
    envToken: Boolean(deps.env.DAHRK_ENROL_TOKEN),
    runtimes: await deps.detectRuntimes(),
    ...(service ? { service } : {}),
    ...(logHint ? { logHint } : {}),
  };
  for (const line of renderStatus(facts)) deps.out(line);

  return service?.installed && !service.running ? 1 : 0;
}
