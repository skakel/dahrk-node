/**
 * Argument parsing for the `dahrk` client. A node is a daemon, so the verbs are a daemon's:
 *
 *   dahrk start  [--token <t>] [--name <n>] [--hub-url <u>] [--foreground] [--ephemeral]  run the node
 *   dahrk stop                                                           stop it (stays stopped)
 *   dahrk restart [--token <t>] [--name <n>] [--hub-url <u>]             stop, then start
 *   dahrk logs [-f] [-n <lines>]                                         what has it been doing?
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
  | "run"
  | "service"
  | "doctor"
  | "status"
  | "update";

/** The two things `dahrk service` can do: register the always-on service, or remove it. */
export type ServiceAction = "install" | "uninstall";

/** Connection + identity flags shared by `start`, `restart`, `stop` and `doctor` (which ignore the ones
 *  that do not apply to them). */
export interface StartFlags {
  token?: string;
  name?: string;
  hubUrl?: string;
  /** Do not read or persist a node id: mint a throwaway one for this run (CI / one-shot nodes). */
  ephemeral: boolean;
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

/** `dahrk logs` flags: how much history, and whether to keep following. */
export interface LogsFlags {
  lines: number;
  follow: boolean;
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

/** `dahrk service <action>` flags: which action, plus the connection/identity flags baked into the
 *  generated unit (uninstall ignores them). */
export interface ServiceFlags {
  action: ServiceAction;
  token?: string;
  name?: string;
  hubUrl?: string;
}

/** `dahrk update` flags: the sole option is `--check`, a dry run that reports whether an update is
 *  available without applying it. */
export interface UpdateFlags {
  check: boolean;
}

export type ParsedCli =
  | { kind: "start"; flags: StartFlags }
  | { kind: "stop" }
  | { kind: "restart"; flags: StartFlags }
  | { kind: "logs"; flags: LogsFlags }
  | { kind: "run"; flags: RunFlags }
  | { kind: "service"; flags: ServiceFlags }
  | { kind: "doctor"; flags: StartFlags }
  | { kind: "status"; flags: StartFlags }
  | { kind: "update"; flags: UpdateFlags }
  | { kind: "help"; command?: Command }
  | { kind: "version" }
  | { kind: "error"; message: string };

const COMMANDS = new Set<Command>([
  "start",
  "stop",
  "restart",
  "logs",
  "run",
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
  // `service` takes a required `install`/`uninstall` action positional plus the connection flags.
  if (command === "service") return parseService(flagArgs);
  // `update` has its own tiny flag set (`--check`), distinct from the connection flags below.
  if (command === "update") return parseUpdate(flagArgs);
  // `logs` is about a file, not a connection: how much of it, and whether to keep watching.
  if (command === "logs") return parseLogs(flagArgs);

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
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }

  if (values.help) return { kind: "help", command };

  const ephemeral = values.ephemeral ?? false;
  const flags: StartFlags = {
    ...(values.token ? { token: values.token } : {}),
    ...(values.name ? { name: values.name } : {}),
    ...(values["hub-url"] ? { hubUrl: values["hub-url"] } : {}),
    ephemeral,
    // An ephemeral node mints a throwaway id and persists nothing, so there is nothing coherent to hand to
    // a supervisor that restarts it on boot. It is a foreground node by definition.
    foreground: (values.foreground ?? false) || ephemeral,
  };
  if (command === "stop") return { kind: "stop" };
  return { kind: command, flags };
}

/** Parse the tail of `dahrk logs [-f] [-n N]`. No positionals: there is only one log to show. */
function parseLogs(flagArgs: string[]): ParsedCli {
  let values;
  try {
    ({ values } = parseArgs({
      args: flagArgs,
      options: {
        follow: { type: "boolean", short: "f", default: false },
        lines: { type: "string", short: "n" },
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
  return { kind: "logs", flags: { lines, follow: values.follow ?? false } };
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

/** Parse the tail of `dahrk update [--check]`: a single optional boolean flag, no positionals. A
 *  `--help` scopes help to `update`. */
function parseUpdate(flagArgs: string[]): ParsedCli {
  let values;
  try {
    ({ values } = parseArgs({
      args: flagArgs,
      options: {
        check: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (values.help) return { kind: "help", command: "update" };
  return { kind: "update", flags: { check: values.check ?? false } };
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
      "",
      "Only one node may run at a time on a host - they would share this machine's node id and race each",
      "other for Jobs - so a second `start` refuses rather than dialling the hub twice.",
    ].join("\n");
  }
  if (command === "stop") {
    return [
      `Usage: ${bin} stop`,
      "",
      "Stop the node. It stays stopped across reboots until you run `dahrk start` again - a stop that",
      "quietly undid itself at the next boot would not be a stop.",
      "",
      "The service stays installed, so starting it again is instant. To remove it entirely, use",
      "`dahrk service uninstall`. To stop a node running in a terminal (--foreground), press Ctrl-C.",
    ].join("\n");
  }
  if (command === "restart") {
    return [
      `Usage: ${bin} restart [options]`,
      "",
      "Stop the node and start it again. Picks up a new client version, a rotated token, or a runtime you",
      "have just installed (the node detects runtimes at boot, so a fresh `claude` on PATH needs a restart).",
      "",
      "Options:",
      "  --token <token>    Re-enrol with a new token (or set DAHRK_ENROL_TOKEN).",
      "  --hub-url <url>    Hub WebSocket URL (or set DAHRK_HUB_URL).",
      "  --name <name>      Display-name override (else the hub assigns one).",
    ].join("\n");
  }
  if (command === "logs") {
    return [
      `Usage: ${bin} logs [-f] [-n <lines>]`,
      "",
      "Show what the node has been doing: its connect / welcome handshake, the Jobs it has run, and anything",
      "it has crashed on. Reads ~/.dahrk/logs/node.out.log and node.err.log, which is where the service",
      "writes on every platform.",
      "",
      "Options:",
      "  -f, --follow       Keep watching as new lines arrive (Ctrl-C to stop).",
      "  -n, --lines <n>    Lines of history to show first (default 200).",
      "",
      "A node run with --foreground logs to its terminal, not to these files, so there is nothing here to",
      "show for one.",
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
      `Usage: ${bin} status`,
      "",
      "Report this node's local state: whether it is enrolled (and as whom), its node id, the runtimes",
      "it can serve, and whether the always-on service is installed and actually running.",
      "",
      "Local only - it dials nothing, so it is instant and works offline. Use `doctor` to check the hub",
      "is reachable and the token still valid. Exits non-zero only when the service is installed but",
      "not running, so it works as a health check in a script.",
    ].join("\n");
  }
  if (command === "update") {
    return [
      `Usage: ${bin} update [--check]`,
      "",
      "Update this client in place to the latest published release. Detects how it was installed",
      "(npm / Homebrew / curl) and runs the right upgrade, or prints the exact command when it cannot.",
      "Reports current -> latest, and a no-op when already current.",
      "",
      "Options:",
      "  --check    Report whether an update is available without applying it (dry run).",
    ].join("\n");
  }
  return [
    `Usage: ${bin} <command> [options]`,
    "",
    "Commands:",
    "  start     Run the node, and keep it running (installs the service). --token to enrol, once.",
    "  stop      Stop the node. It stays stopped until the next `start`.",
    "  restart   Stop it and start it again.",
    "  logs      Show what the node is doing (-f to follow).",
    "  status    Is this node enrolled, and is it up? (local, dials nothing)",
    "  run       Run a workflow locally (engine-backed), e.g. `run preflight`.",
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
