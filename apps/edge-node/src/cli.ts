/**
 * Argument parsing for the `dahrk` client. The surface is a small set of subcommands:
 *
 *   dahrk start  --token <t> [--name <n>] [--hub-url <u>] [--ephemeral]   run the node
 *   dahrk run <workflow> [--repo <p>] [--hub-url <u>] [--token <t>]       run a workflow (engine-backed)
 *   dahrk doctor [--token <t>] [--hub-url <u>]                            preflight checks
 *   dahrk help [command] | --help                                        usage
 *   dahrk version | --version                                            print the client version
 *
 * `start` is the default when no subcommand is given, so the pre-subcommand invocation
 * (`dahrk-node --token X`) keeps working. Parsing is pure and returns a discriminated result - the
 * caller decides what to print / exit with - so it is unit-testable without touching argv or process.
 */
import { parseArgs } from "node:util";

export type Command = "start" | "run" | "doctor";

/** Connection + identity flags shared by `start` and `doctor` (doctor ignores the run-only ones). */
export interface StartFlags {
  token?: string;
  name?: string;
  hubUrl?: string;
  /** Do not read or persist a node id: mint a throwaway one for this run (CI / one-shot nodes). */
  ephemeral: boolean;
}

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

export type ParsedCli =
  | { kind: "start"; flags: StartFlags }
  | { kind: "run"; flags: RunFlags }
  | { kind: "doctor"; flags: StartFlags }
  | { kind: "help"; command?: Command }
  | { kind: "version" }
  | { kind: "error"; message: string };

const COMMANDS = new Set<Command>(["start", "run", "doctor"]);
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

  let values;
  try {
    ({ values } = parseArgs({
      args: flagArgs,
      options: {
        token: { type: "string" },
        name: { type: "string" },
        "hub-url": { type: "string" },
        ephemeral: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }

  if (values.help) return { kind: "help", command };

  const flags: StartFlags = {
    ...(values.token ? { token: values.token } : {}),
    ...(values.name ? { name: values.name } : {}),
    ...(values["hub-url"] ? { hubUrl: values["hub-url"] } : {}),
    ephemeral: values.ephemeral ?? false,
  };
  return { kind: command, flags };
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

/** The usage/help text. `bin` is the invoked program name; `command` scopes help to one subcommand. */
export function usage(bin: string, command?: Command): string {
  if (command === "start") {
    return [
      `Usage: ${bin} start --token <token> [options]`,
      "",
      "Run the edge node: dial the hub over WebSocket and serve Jobs in git worktrees.",
      "",
      "Options:",
      "  --token <token>    Enrolment token (required; or set DAHRK_ENROL_TOKEN).",
      "  --hub-url <url>    Hub WebSocket URL (or set DAHRK_HUB_URL).",
      "  --name <name>      Display-name override (else the hub assigns one).",
      "  --ephemeral        Do not persist a node id; mint a throwaway one (CI / one-shot).",
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
  return [
    `Usage: ${bin} <command> [options]`,
    "",
    "Commands:",
    "  start     Run the edge node (default). Needs a --token and a hub URL.",
    "  run       Run a workflow locally (engine-backed), e.g. `run preflight`.",
    "  doctor    Preflight checks: Node, runtimes, hub reachability, token validity.",
    "  version   Print the client version.",
    "  help      Show this help, or `help <command>` for a command's options.",
    "",
    `Run \`${bin} help <command>\` for command-specific options.`,
  ].join("\n");
}
