/**
 * Argument parsing for the `dahrk` client. A node is a daemon, so the verbs are a daemon's:
 *
 *   dahrk start  [--token <t>] [--name <n>] [--hub-url <u>] [--foreground] [--ephemeral]  run the node
 *   dahrk stop                                                           stop it (stays stopped)
 *   dahrk restart [--token <t>] [--name <n>] [--hub-url <u>]             stop, then start
 *   dahrk logs [-f] [-n <lines>] [--level <l>] [--run <id>] [--json]     what has it been doing?
 *   dahrk diagnose [--out <path>]                                        a support bundle you can read
 *   dahrk status                                                         enrolled? up? (local, dials nothing)
 *   dahrk run <workflow> [--repo <p>] [--hub-url <u>] [--token <t>]      run a workflow (engine-backed)
 *   dahrk doctor [--token <t>] [--hub-url <u>]                           preflight checks
 *   dahrk service install|uninstall [--token <t>] [--name <n>] [--hub-url <u>]  the service, by hand
 *   dahrk update [--check]                                               self-update to the latest client
 *   dahrk help [command] | --help                                        usage
 *   dahrk version | --version                                            print the client version
 *
 * `start` means "ensure the node is running": it installs the service, starts it, and returns. The blocking
 * worker that actually dials the hub is `start --foreground` - which is what the service itself invokes,
 * and what a container or pm2 should invoke. See `StartFlags.foreground`.
 *
 * `start` is also the default when no subcommand is given, so the pre-subcommand invocation
 * (`dahrk-node --token X`) keeps working. Parsing is pure and returns a discriminated result - the
 * caller decides what to print / exit with - so it is unit-testable without touching argv or process.
 */
import { parseArgs } from "node:util";

export type Command =
  | "start"
  | "stop"
  | "restart"
  | "logs"
  | "diagnose"
  | "run"
  | "repo"
  | "service"
  | "doctor"
  | "status"
  | "update";

/** The two things `dahrk service` can do: register the always-on service, or remove it. */
export type ServiceAction = "install" | "uninstall";

/** What `dahrk repo` can do. One action today - `add` registers the current repo - but structured as an
 *  action positional so `list`/`remove` can grow here later without another top-level command. */
export type RepoAction = "add";

/** Connection + identity flags shared by `start`, `restart`, `stop` and `doctor` (which ignore the ones
 *  that do not apply to them). */
export interface StartFlags {
  token?: string;
  name?: string;
  hubUrl?: string;
  /** Do not read or persist a node id: mint a throwaway one for this run (CI / one-shot nodes). */
  ephemeral: boolean;
  /** `start` only: enrol (leave the token on disk) but do not install the always-on service, for a
   *  node the operator supervises themselves. Absent unless `--no-service` was passed. */
  noService?: boolean;
  /** Run the node in THIS process and block, instead of handing it to a supervisor.
   *
   *  This is what `dahrk start` used to do, and it is still a first-class way to run a node: in a
   *  container, under pm2, in CI, or just to watch one in a terminal. It is also what the installed service
   *  invokes - the supervised process must run the worker, or it would recurse into trying to start itself.
   *  `DAHRK_FOREGROUND=1` is the same instruction by environment, for the places where argv is awkward to
   *  control (a Dockerfile, a pm2 config), and `--ephemeral` implies it: there is nothing to daemonise
   *  about a node that deliberately has no persistent identity. */
  foreground: boolean;
}

/** `dahrk logs` flags: how much history, whether to keep following, and (the structured mode) what to
 *  narrow to.
 *
 *  Two modes, because there are two logs. Bare `dahrk logs` tails the plain transcript the supervisor
 *  captured (`node.out.log` / `node.err.log`) - the markers, as printed. Passing any of `--run`,
 *  `--level` or `--json` switches to reading `node.jsonl`, the node's own structured log, which is the
 *  only one that carries levels, correlation ids and stacks. `--run` is the payoff: it is what makes a
 *  node's log joinable to a hub run. */
export interface LogsFlags {
  lines: number;
  follow: boolean;
  /** Only records at this level or above. Implies the structured mode. */
  level?: string;
  /** Only records for this run id. Implies the structured mode. */
  run?: string;
  /** Emit the raw JSON records rather than a rendered line. Implies the structured mode. */
  json: boolean;
}

/** Is this a structured query (read node.jsonl) or the plain transcript tail? */
export const isStructuredLogs = (f: LogsFlags): boolean => f.level !== undefined || f.run !== undefined || f.json;

/** `dahrk diagnose` flags. There is no `--upload`, by design; see `diagnose.ts`. */
export interface DiagnoseFlags {
  /** Write the bundle here instead of the default timestamped file in the current directory. */
  out?: string;
}

/** Lines of history `dahrk logs` shows by default - enough to cover the last connect / welcome handshake
 *  and a Job or two, which is what you are nearly always looking for. Defined here, with the flag that sets
 *  it, so there is one number rather than a parser default and a runner default drifting apart. */
export const DEFAULT_LOG_LINES = 200;

/** `dahrk run <workflow>` flags: which workflow, which repo to inspect, and the (optional) hub/token so
 *  the run can probe reachability. A workflow run is issue-less - no `--name` / `--ephemeral`. */
export interface RunFlags {
  /** The workflow to run (first target: `preflight`). */
  workflow: string;
  /** The repo to inspect; defaults to the current working directory. */
  repo?: string;
  token?: string;
  hubUrl?: string;
}

/** `dahrk repo add` flags: everything is optional because the command operates on the current working
 *  directory. `--name` overrides the slug derived from the origin URL; `--hub-url`/`--token` override
 *  the configured hub and the cached enrolment token for talking to the hub. */
export interface RepoAddFlags {
  name?: string;
  hubUrl?: string;
  token?: string;
}

/** `dahrk service <action>` flags: which action, plus the connection/identity flags baked into the
 *  generated unit (uninstall ignores them). */
export interface ServiceFlags {
  action: ServiceAction;
  token?: string;
  name?: string;
  hubUrl?: string;
}

/** `dahrk update` flags: `--check` is a dry run that reports whether an update is available without
 *  applying it; `--verbose` shows the package manager's own output even when it succeeds (it is hidden by
 *  default, because a successful npm install is a wall of peer-dependency warnings about nothing). */
export interface UpdateFlags {
  check: boolean;
  verbose: boolean;
}

/** `dahrk status` flags: `--json` prints the facts as JSON for a script, and nothing else. */
export interface StatusFlags extends StartFlags {
  json: boolean;
}

export type ParsedCli =
  | { kind: "start"; flags: StartFlags }
  | { kind: "stop"; force: boolean }
  | { kind: "restart"; flags: StartFlags; force: boolean }
  | { kind: "logs"; flags: LogsFlags }
  | { kind: "diagnose"; flags: DiagnoseFlags }
  | { kind: "run"; flags: RunFlags }
  | { kind: "repo"; flags: RepoAddFlags }
  | { kind: "service"; flags: ServiceFlags }
  | { kind: "doctor"; flags: StartFlags }
  | { kind: "status"; flags: StatusFlags }
  | { kind: "update"; flags: UpdateFlags }
  | { kind: "help"; command?: Command }
  | { kind: "version" }
  | { kind: "error"; message: string };

const COMMANDS = new Set<Command>([
  "start",
  "stop",
  "restart",
  "logs",
  "diagnose",
  "run",
  "repo",
  "service",
  "doctor",
  "status",
  "update",
]);
const isCommand = (s: string): s is Command => (COMMANDS as Set<string>).has(s);

/** Parse the argv tail (i.e. `process.argv.slice(2)`) into a command + flags, or a help/error verdict. */
export function parseCli(argv: string[]): ParsedCli {
  const [first, ...rest] = argv;

  // Top-level help / version, in either `dahrk help` or `dahrk --help` spelling.
  if (first === "help" || first === "--help" || first === "-h") {
    const sub = rest[0];
    return sub && isCommand(sub) ? { kind: "help", command: sub } : { kind: "help" };
  }
  if (first === "version" || first === "--version" || first === "-v") return { kind: "version" };

  // Resolve the subcommand. A leading non-flag token must be a known command; otherwise we default to
  // `start` and treat the whole tail as its flags (back-compat with the flag-first invocation).
  let command: Command = "start";
  let flagArgs = argv;
  if (first !== undefined && !first.startsWith("-")) {
    if (!isCommand(first)) {
      return { kind: "error", message: `unknown command: ${first}` };
    }
    command = first;
    flagArgs = rest;
  }

  // `run` takes a required `<workflow>` positional plus repo/hub/token flags, so it parses on its own
  // path (the other commands forbid positionals).
  if (command === "run") return parseRun(flagArgs);
  // `repo` takes a required `add` action positional plus the name/connection flags.
  if (command === "repo") return parseRepo(flagArgs);
  // `service` takes a required `install`/`uninstall` action positional plus the connection flags.
  if (command === "service") return parseService(flagArgs);
  // `update` has its own tiny flag set (`--check`), distinct from the connection flags below.
  if (command === "update") return parseUpdate(flagArgs);
  // `logs` is about a file, not a connection: how much of it, and whether to keep watching.
  if (command === "logs") return parseLogs(flagArgs);
  // `diagnose` writes a file; the only choice is where.
  if (command === "diagnose") return parseDiagnose(flagArgs);

  let values;
  try {
    ({ values } = parseArgs({
      args: flagArgs,
      options: {
        token: { type: "string" },
        name: { type: "string" },
        "hub-url": { type: "string" },
        ephemeral: { type: "boolean", default: false },
        foreground: { type: "boolean", default: false },
        // `start`: enrol but do not install the service (the operator supervises the node themselves).
        "no-service": { type: "boolean", default: false },
        // `stop` / `restart`: take the node down even though it has work in flight.
        force: { type: "boolean", default: false },
        // `status`: machine-readable output.
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }

  if (values.help) return { kind: "help", command };

  const ephemeral = values.ephemeral ?? false;
  const force = values.force ?? false;
  const flags: StartFlags = {
    ...(values.token ? { token: values.token } : {}),
    ...(values.name ? { name: values.name } : {}),
    ...(values["hub-url"] ? { hubUrl: values["hub-url"] } : {}),
    ephemeral,
    // An ephemeral node mints a throwaway id and persists nothing, so there is nothing coherent to hand to
    // a supervisor that restarts it on boot. It is a foreground node by definition.
    foreground: (values.foreground ?? false) || ephemeral,
    ...(values["no-service"] ? { noService: true } : {}),
  };
  if (command === "stop") return { kind: "stop", force };
  if (command === "restart") return { kind: "restart", flags, force };
  if (command === "status") return { kind: "status", flags: { ...flags, json: values.json ?? false } };
  return { kind: command as "start" | "doctor", flags };
}

/** The levels `--level` accepts, loudest last. A filter of `warn` means "warn, error and fatal". */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

/** Parse the tail of `dahrk logs [-f] [-n N] [--level L] [--run ID] [--json]`. No positionals. */
function parseLogs(flagArgs: string[]): ParsedCli {
  let values;
  try {
    ({ values } = parseArgs({
      args: flagArgs,
      options: {
        follow: { type: "boolean", short: "f", default: false },
        lines: { type: "string", short: "n" },
        level: { type: "string" },
        run: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (values.help) return { kind: "help", command: "logs" };

  const lines = values.lines === undefined ? DEFAULT_LOG_LINES : Number(values.lines);
  if (!Number.isInteger(lines) || lines < 0) {
    return { kind: "error", message: `logs: --lines must be a non-negative whole number (got "${values.lines}")` };
  }
  if (values.level !== undefined && !(LOG_LEVELS as readonly string[]).includes(values.level)) {
    return { kind: "error", message: `logs: --level must be one of ${LOG_LEVELS.join(", ")} (got "${values.level}")` };
  }
  return {
    kind: "logs",
    flags: {
      lines,
      follow: values.follow ?? false,
      ...(values.level ? { level: values.level } : {}),
      ...(values.run ? { run: values.run } : {}),
      json: values.json ?? false,
    },
  };
}

/** Parse the tail of `dahrk diagnose [--out <path>]`. */
function parseDiagnose(flagArgs: string[]): ParsedCli {
  let values;
  try {
    ({ values } = parseArgs({
      args: flagArgs,
      options: {
        out: { type: "string" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (values.help) return { kind: "help", command: "diagnose" };
  return { kind: "diagnose", flags: { ...(values.out ? { out: values.out } : {}) } };
}

/** Parse the tail of `dahrk run <workflow> [flags]`: a single required workflow positional plus the
 *  run flags. A `--help` before the workflow scopes help to `run`; a missing/extra positional is an error. */
function parseRun(flagArgs: string[]): ParsedCli {
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: flagArgs,
      options: {
        repo: { type: "string" },
        token: { type: "string" },
        "hub-url": { type: "string" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
    }));
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (values.help) return { kind: "help", command: "run" };
  if (positionals.length === 0) {
    return { kind: "error", message: "run: missing workflow (e.g. `dahrk run preflight`)" };
  }
  if (positionals.length > 1) {
    return { kind: "error", message: `run: unexpected argument "${positionals[1]}" (one workflow at a time)` };
  }
  const flags: RunFlags = {
    workflow: positionals[0] as string,
    ...(values.repo ? { repo: values.repo } : {}),
    ...(values.token ? { token: values.token } : {}),
    ...(values["hub-url"] ? { hubUrl: values["hub-url"] } : {}),
  };
  return { kind: "run", flags };
}

const SERVICE_ACTIONS = new Set<ServiceAction>(["install", "uninstall"]);
const isServiceAction = (s: string): s is ServiceAction => (SERVICE_ACTIONS as Set<string>).has(s);

/** Parse the tail of `dahrk service <action> [flags]`: a required `install`/`uninstall` positional plus
 *  the connection/identity flags. A `--help` scopes help to `service`; a missing/unknown/extra action
 *  is an error. */
function parseService(flagArgs: string[]): ParsedCli {
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: flagArgs,
      options: {
        token: { type: "string" },
        name: { type: "string" },
        "hub-url": { type: "string" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
    }));
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (values.help) return { kind: "help", command: "service" };
  if (positionals.length === 0) {
    return { kind: "error", message: "service: missing action (`dahrk service install` or `uninstall`)" };
  }
  if (positionals.length > 1) {
    return { kind: "error", message: `service: unexpected argument "${positionals[1]}" (one action at a time)` };
  }
  const action = positionals[0] as string;
  if (!isServiceAction(action)) {
    return { kind: "error", message: `service: unknown action "${action}" (expected install or uninstall)` };
  }
  const flags: ServiceFlags = {
    action,
    ...(values.token ? { token: values.token } : {}),
    ...(values.name ? { name: values.name } : {}),
    ...(values["hub-url"] ? { hubUrl: values["hub-url"] } : {}),
  };
  return { kind: "service", flags };
}

const REPO_ACTIONS = new Set<RepoAction>(["add"]);
const isRepoAction = (s: string): s is RepoAction => (REPO_ACTIONS as Set<string>).has(s);

/** Parse the tail of `dahrk repo add [flags]`: a required `add` action positional plus the optional
 *  name/hub/token flags. A `--help` scopes help to `repo`; a missing/unknown/extra action is an error.
 *  Mirrors `parseService`, since `repo` is the same shape (action positional + flags). */
function parseRepo(flagArgs: string[]): ParsedCli {
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: flagArgs,
      options: {
        name: { type: "string" },
        "hub-url": { type: "string" },
        token: { type: "string" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: true,
    }));
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (values.help) return { kind: "help", command: "repo" };
  if (positionals.length === 0) {
    return { kind: "error", message: "repo: missing action (`dahrk repo add`)" };
  }
  if (positionals.length > 1) {
    return { kind: "error", message: `repo: unexpected argument "${positionals[1]}" (one action at a time)` };
  }
  const action = positionals[0] as string;
  if (!isRepoAction(action)) {
    return { kind: "error", message: `repo: unknown action "${action}" (expected add)` };
  }
  const flags: RepoAddFlags = {
    ...(values.name ? { name: values.name } : {}),
    ...(values["hub-url"] ? { hubUrl: values["hub-url"] } : {}),
    ...(values.token ? { token: values.token } : {}),
  };
  return { kind: "repo", flags };
}

/** Parse the tail of `dahrk update [--check]`: a single optional boolean flag, no positionals. A
 *  `--help` scopes help to `update`. */
function parseUpdate(flagArgs: string[]): ParsedCli {
  let values;
  try {
    ({ values } = parseArgs({
      args: flagArgs,
      options: {
        check: { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (values.help) return { kind: "help", command: "update" };
  return { kind: "update", flags: { check: values.check ?? false, verbose: values.verbose ?? false } };
}

/** The usage/help text. `bin` is the invoked program name; `command` scopes help to one subcommand. */
export function usage(bin: string, command?: Command): string {
  if (command === "start") {
    return [
      `Usage: ${bin} start [--token <token>] [options]`,
      "",
      "Make this node run, and keep running: install it as an always-on service (launchd / systemd), start",
      "it, and return. It restarts on failure and comes back after a reboot. Running it again is a no-op if",
      "the node is already up, so it is safe to repeat.",
      "",
      "A token is needed only to enrol. Once the hub accepts it, it is cached in ~/.dahrk/node.json and",
      "every later `start` re-attaches without one. Pass --token again to re-enrol (rotated token, new pool).",
      "",
      "Once it is running:",
      `  ${bin} logs -f      Watch what it is doing.`,
      `  ${bin} status       Is it enrolled, and is it up?`,
      `  ${bin} stop         Stop it (it stays stopped until the next \`start\`).`,
      "",
      "Options:",
      "  --token <token>    Enrolment token (first run only; or set DAHRK_ENROL_TOKEN).",
      "  --hub-url <url>    Hub WebSocket URL (or set DAHRK_HUB_URL).",
      "  --name <name>      Display-name override (else the hub assigns one).",
      "  --foreground       Run the node in THIS terminal and block, instead of as a service. For",
      "                     containers, pm2, CI, or just watching one work. Ctrl-C stops it. Same thing as",
      "                     setting DAHRK_FOREGROUND=1, which is easier to set in a Dockerfile or pm2 config.",
      "  --ephemeral        Do not persist (or read) node id and token; mint a throwaway id (CI / one-shot).",
      "                     Implies --foreground: a node with no persistent identity has nothing to daemonise.",
      "  --no-service       Enrol (cache the token) but do not install the always-on service, for a node you",
      "                     supervise yourself. Run it later with `dahrk start --foreground` (or your own supervisor).",
      "",
      "Only one node may run at a time on a host - they would share this machine's node id and race each",
      "other for Jobs - so a second `start` refuses rather than dialling the hub twice.",
    ].join("\n");
  }
  if (command === "stop") {
    return [
      `Usage: ${bin} stop [--force]`,
      "",
      "Stop the node. It stays stopped across reboots until you run `dahrk start` again - a stop that",
      "quietly undid itself at the next boot would not be a stop.",
      "",
      "A node that is running a stage refuses to stop, because stopping it would kill work that costs real",
      "agent time. It lists what is in flight and leaves the node up; --force stops it anyway.",
      "",
      "The service stays installed, so starting it again is instant. To remove it entirely, use",
      "`dahrk service uninstall`. To stop a node running in a terminal (--foreground), press Ctrl-C.",
      "",
      "Options:",
      "  --force            Stop even if the node has stages in flight (this kills them).",
    ].join("\n");
  }
  if (command === "restart") {
    return [
      `Usage: ${bin} restart [options]`,
      "",
      "Stop the node and start it again, then report its status. Picks up a new client version, a rotated",
      "token, or a runtime you have just installed (the node detects runtimes at boot, so a fresh `claude`",
      "on PATH needs a restart).",
      "",
      "This is what picks up a `dahrk update`: a running node keeps executing the build it started with, so",
      "`dahrk start` on it does nothing at all.",
      "",
      "Like `stop`, it refuses on a node with stages in flight rather than killing them; --force overrides.",
      "",
      "Options:",
      "  --token <token>    Re-enrol with a new token (or set DAHRK_ENROL_TOKEN).",
      "  --hub-url <url>    Hub WebSocket URL (or set DAHRK_HUB_URL).",
      "  --name <name>      Display-name override (else the hub assigns one).",
      "  --force            Restart even if the node has stages in flight (this kills them).",
    ].join("\n");
  }
  if (command === "logs") {
    return [
      `Usage: ${bin} logs [-f] [-n <lines>] [--level <l>] [--run <id>] [--json]`,
      "",
      "Show what the node has been doing: its connect / welcome handshake, the Jobs it has run, and anything",
      "it has crashed on.",
      "",
      "There are two logs, and this reads whichever you ask for. On its own it tails the transcript the",
      "service captured (~/.dahrk/logs/node.out.log and node.err.log) - the same lines the node printed.",
      "Pass --level, --run or --json and it reads node.jsonl instead: the node's own structured log, which",
      "is the one carrying levels, timestamps, correlation ids and full error stacks. It is written at",
      "debug even when the terminal is not, so the detail for an incident is already there afterwards.",
      "",
      "Options:",
      "  -f, --follow       Keep watching as new lines arrive (Ctrl-C to stop).",
      "  -n, --lines <n>    Lines of history to show first (default 200).",
      "  --level <level>    Only this level and above: trace, debug, info, warn, error, fatal.",
      "  --run <runId>      Only this run. The runId is the hub's - so `logs --run <id>` and the hub's",
      "                     view of the same run describe the same thing from both ends.",
      "  --json             Print the raw JSON records (for jq) rather than a rendered line.",
      "",
      "A node run with --foreground prints to its terminal, but it still writes node.jsonl - so --run and",
      "--level work for it too.",
    ].join("\n");
  }
  if (command === "diagnose") {
    return [
      `Usage: ${bin} diagnose [--out <path>]`,
      "",
      "Write a support bundle: everything needed to debug this node, in one file you can read.",
      "",
      "It collects this node's id, name, tenant, version and host; the doctor's verdict; the tail of the",
      "structured log; and every crash record. Secrets are stripped and the enrolment token is not",
      "included. Your source code, prompts and issue content are not included.",
      "",
      "Nothing is uploaded. There is no flag to upload it. The file is written locally so that you can open",
      "it, read every line, and decide for yourself whether to send it on.",
      "",
      "Options:",
      "  --out <path>       Write the bundle here (default: ./dahrk-diagnose-<timestamp>.json).",
    ].join("\n");
  }
  if (command === "run") {
    return [
      `Usage: ${bin} run <workflow> [options]`,
      "",
      "Run a workflow through the engine locally against this node's worktree, streaming stage progress.",
      "The engine-backed twin of `doctor`: the same run and stages, from the terminal - no Linear, no issue.",
      "",
      "Workflows:",
      "  preflight    Is this floor sound enough to run? Checks node, repo, and tools, then reports.",
      "",
      "Options:",
      "  --repo <path>      Repo to inspect (default: the current directory).",
      "  --hub-url <url>    Hub WebSocket URL to probe for reachability (or set DAHRK_HUB_URL).",
      "  --token <token>    Enrolment token to verify against the hub (or set DAHRK_ENROL_TOKEN).",
    ].join("\n");
  }
  if (command === "repo") {
    return [
      `Usage: ${bin} repo add [options]`,
      "",
      "Register the current git repository with the hub, so it can run workflows. Run it from inside the",
      "repo - `cd your-repo && dahrk repo add` - and the node reads the `origin` remote and the current",
      "branch itself: no form, no pasted git URL, because the node already sits next to the code.",
      "",
      "The git URL is registered in the form the host can authenticate. An HTTPS origin is kept as-is; an",
      "SSH origin is kept when this host has an SSH key, and otherwise normalised to HTTPS with a warning.",
      "Re-running on an already-registered repo is a no-op, not an error or a duplicate.",
      "",
      "This uses the node's existing enrolment - run `dahrk start --token <token>` first if it is not yet",
      "enrolled. It dials the hub itself, so the daemon need not be running.",
      "",
      "Actions:",
      "  add          Register the repository in the current directory.",
      "",
      "Options:",
      "  --name <name>      Display name for the repo (default: the slug from the origin URL).",
      "  --hub-url <url>    Hub URL to register with (or set DAHRK_HUB_URL).",
      "  --token <token>    Enrolment token to authenticate with (default: the cached one).",
    ].join("\n");
  }
  if (command === "service") {
    return [
      `Usage: ${bin} service install|uninstall [options]`,
      "",
      "Install (or remove) the node as an always-on service that starts on boot and restarts on",
      "failure - a launchd LaunchAgent on macOS, a systemd user service on Linux. No pm2, no root.",
      "The node id persisted at ~/.dahrk/node.json means it re-attaches as the same node across reboots.",
      "",
      "Actions:",
      "  install      Generate and register the service, then start it.",
      "  uninstall    Stop, deregister, and remove the service.",
      "",
      "Options (install; baked into the service, uninstall ignores them):",
      "  --token <token>    Enrolment token (required; or set DAHRK_ENROL_TOKEN).",
      "  --hub-url <url>    Hub WebSocket URL (or set DAHRK_HUB_URL).",
      "  --name <name>      Display-name override (else the hub assigns one).",
    ].join("\n");
  }
  if (command === "doctor") {
    return [
      `Usage: ${bin} doctor [options]`,
      "",
      "Run preflight checks: Node version, installed runtimes, hub reachability, token validity.",
      "",
      "Options:",
      "  --token <token>    Enrolment token to validate (or set DAHRK_ENROL_TOKEN).",
      "  --hub-url <url>    Hub WebSocket URL to reach (or set DAHRK_HUB_URL).",
    ].join("\n");
  }
  if (command === "status") {
    return [
      `Usage: ${bin} status [--json]`,
      "",
      "Report this node's local state: whether it is running (and how), whether it is enrolled and as whom,",
      "its node id, the runtimes it can serve with their versions, and what it is working on right now.",
      "",
      "Local only - it dials nothing, so it is instant and works offline. That is also why the hub line says",
      "when the node was LAST known to be connected (from its log) rather than claiming it is connected now,",
      "which this command cannot know without dialling. Use `doctor` for that: it checks the hub is",
      "reachable and the token still valid.",
      "",
      "Exits non-zero only when the node is installed but not running and nobody asked for that (i.e. it is",
      "crash-looping), so it works as a health check in a script. A node you deliberately stopped is not a",
      "failure.",
      "",
      "Options:",
      "  --json     Print the facts as JSON (for a script) instead of the report.",
    ].join("\n");
  }
  if (command === "update") {
    return [
      `Usage: ${bin} update [--check] [--verbose]`,
      "",
      "Update this client in place to the latest published release. Detects how it was installed",
      "(npm / Homebrew / curl) and runs the right upgrade, or prints the exact command when it cannot.",
      "Reports current -> latest, and a no-op when already current.",
      "",
      "A node that is already running keeps executing the OLD build until it is restarted, so if one is up",
      "this offers to restart it for you (and tells you to run `dahrk restart` when there is nobody to ask).",
      "",
      "Options:",
      "  --check    Report whether an update is available without applying it (dry run).",
      "  --verbose  Show the package manager's own output, which is hidden unless the upgrade fails.",
    ].join("\n");
  }
  return [
    `Usage: ${bin} <command> [options]`,
    "",
    "Commands:",
    "  start     Run the node, and keep it running (installs the service). --token to enrol, once.",
    "  stop      Stop the node. It stays stopped until the next `start`.",
    "  restart   Stop it and start it again. This is what picks up a `dahrk update`.",
    "  logs      Show what the node is doing (-f to follow, --run <id> to narrow to one run).",
    "  diagnose  Write a support bundle you can read, and send on if you choose. Uploads nothing.",
    "  status    Is it up, is it enrolled, what is it working on? (local, dials nothing)",
    "  run       Run a workflow locally (engine-backed), e.g. `run preflight`.",
    "  repo      Register the current repository with the hub (`repo add`).",
    "  doctor    Preflight checks: Node, runtimes, hub reachability, token validity.",
    "  service   Install/uninstall the always-on service by hand (`start` does this for you).",
    "  update    Update the client to the latest release (or print how for your channel).",
    "  version   Print the client version.",
    "  help      Show this help, or `help <command>` for a command's options.",
    "",
    `Run \`${bin} help <command>\` for command-specific options.`,
    `To run a node in this terminal instead of as a service: \`${bin} start --foreground\`.`,
  ].join("\n");
}
