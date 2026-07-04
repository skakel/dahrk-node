/**
 * Argument parsing for the `dahrk` client. The surface is a small set of subcommands:
 *
 *   dahrk start  --token <t> [--name <n>] [--hub-url <u>] [--ephemeral]   run the node
 *   dahrk doctor [--token <t>] [--hub-url <u>]                            preflight checks
 *   dahrk help [command] | --help                                        usage
 *   dahrk version | --version                                            print the client version
 *
 * `start` is the default when no subcommand is given, so the pre-subcommand invocation
 * (`dahrk-node --token X`) keeps working. Parsing is pure and returns a discriminated result - the
 * caller decides what to print / exit with - so it is unit-testable without touching argv or process.
 */
import { parseArgs } from "node:util";

export type Command = "start" | "doctor";

/** Connection + identity flags shared by `start` and `doctor` (doctor ignores the run-only ones). */
export interface StartFlags {
  token?: string;
  name?: string;
  hubUrl?: string;
  /** Do not read or persist a node id: mint a throwaway one for this run (CI / one-shot nodes). */
  ephemeral: boolean;
}

export type ParsedCli =
  | { kind: "start"; flags: StartFlags }
  | { kind: "doctor"; flags: StartFlags }
  | { kind: "help"; command?: Command }
  | { kind: "version" }
  | { kind: "error"; message: string };

const COMMANDS = new Set<Command>(["start", "doctor"]);
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
    "  doctor    Preflight checks: Node, runtimes, hub reachability, token validity.",
    "  version   Print the client version.",
    "  help      Show this help, or `help <command>` for a command's options.",
    "",
    `Run \`${bin} help <command>\` for command-specific options.`,
  ].join("\n");
}
