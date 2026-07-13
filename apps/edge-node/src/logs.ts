/**
 * `dahrk logs` - what is this node actually doing?
 *
 * The question you ask the moment the node stops being a thing in your terminal and starts being a daemon.
 * Before this, the answer was "know that macOS writes `~/.dahrk/logs/node.err.log` and Linux writes to the
 * journal, and type the right incantation for the host you happen to be on". Both managers now write the
 * same two files (see `renderSystemdUnit`), so this is one command with one behaviour everywhere.
 *
 * It shells out to `tail` rather than reimplementing follow-mode: `tail` is on both targets, it already
 * handles the file being appended to (and truncated, on rotation) under it, and a hand-rolled `fs.watch`
 * loop would be a worse version of it. The argv is built by a pure function so the decisions - which files,
 * how many lines, follow or not - are testable without spawning anything.
 */
import { spawn } from "node:child_process";
import { out as uiOut } from "./ui.js";
import { copyFileSync, existsSync, readFileSync, statSync, truncateSync } from "node:fs";

/** Beyond this, the log is rotated on the next node boot. The node logs a line per lifecycle event, so
 *  this is months of normal operation - it exists to bound a pathological case (a crash-loop, a chatty
 *  runtime), not to be hit routinely. */
export const MAX_LOG_BYTES = 10 * 1024 * 1024;

export interface LogsInputs {
  files: string[];
  lines: number;
  follow: boolean;
}

/** The `tail` invocation. Both files are passed together so the output interleaves in real time (tail
 *  prints a `==> file <==` banner as it switches), which is what you want: stdout carries the lifecycle
 *  and Job markers, stderr carries the crashes, and reading either alone tells you half the story. */
export function logsCommand(inputs: LogsInputs): string[] {
  return [
    "tail",
    "-n",
    String(inputs.lines),
    ...(inputs.follow ? ["-f"] : []),
    ...inputs.files,
  ];
}

export interface LogsDeps {
  files: { out: string; err: string };
  /** The node's own structured log (`node.jsonl`), read by the `--run` / `--level` / `--json` mode. */
  jsonlFile: string;
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string;
  /** Spawn tail, inheriting stdio, and resolve with its exit code. */
  run: (argv: string[]) => Promise<number>;
  out: (line: string) => void;
}

/** Levels, loudest last. `--level warn` means warn, error and fatal. */
const LEVEL_RANK: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

/** One line of `node.jsonl`. pino writes `level` as a NUMBER, which is why the filter compares ranks
 *  rather than names. Everything else is whatever we bound onto the record. */
interface LogRecord {
  level: number;
  time: string;
  msg: string;
  runId?: string;
  stageId?: string;
  jobId?: string;
  component?: string;
  err?: { type?: string; message?: string; stack?: string };
  [k: string]: unknown;
}

const levelName = (n: number): string =>
  Object.entries(LEVEL_RANK).find(([, rank]) => rank === n)?.[0] ?? String(n);

/** Parse a JSONL log, skipping torn lines (we may be reading while the node writes). */
export function parseRecords(raw: string): LogRecord[] {
  const out: LogRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogRecord);
    } catch {
      /* a torn final line is normal; the rest of the log is still worth reading */
    }
  }
  return out;
}

/** Apply the `--level` / `--run` filters and cap to the last `lines`. Pure, so it unit-tests directly. */
export function filterRecords(
  records: LogRecord[],
  q: { level?: string | undefined; run?: string | undefined; lines: number },
): LogRecord[] {
  const min = q.level ? (LEVEL_RANK[q.level] ?? 0) : 0;
  const matched = records.filter((r) => r.level >= min && (q.run === undefined || r.runId === q.run));
  return q.lines > 0 ? matched.slice(-q.lines) : matched;
}

/**
 * Render one record for a human.
 *
 * The structured mode is the one you reach for when something is wrong, so it leads with what you are
 * scanning for - when, how bad, and which run - and puts the message last where the eye lands. A stack,
 * when there is one, is worth every line it costs: it is the reason this mode exists.
 */
export function renderRecord(r: LogRecord): string[] {
  const where = [r.runId, r.stageId].filter(Boolean).join("/");
  const scope = where ? ` [${where}]` : r.component ? ` [${r.component}]` : "";
  const head = `${r.time} ${levelName(r.level).toUpperCase().padEnd(5)}${scope} ${r.msg}`;
  const lines = [head];
  if (r.err?.stack) lines.push(...r.err.stack.split("\n").map((l) => `    ${l}`));
  return lines;
}

/**
 * Print (and optionally follow) the node's logs. Returns the process exit code.
 *
 * A node that has never run as a service has no log files, and `tail` would fail with a bare ENOENT that
 * says nothing useful. That is not an error - it is a node you have not started yet - so we say that
 * instead, and point at the command that explains why.
 */
export async function runLogs(
  inputs: { lines: number; follow: boolean; level?: string | undefined; run?: string | undefined; json?: boolean },
  deps: LogsDeps,
): Promise<number> {
  // Any of --level / --run / --json means "read the structured log", because none of them can be
  // answered from the plain transcript: it has no levels, no ids, and no JSON.
  if (inputs.level !== undefined || inputs.run !== undefined || inputs.json) {
    return runStructuredLogs(inputs, deps);
  }

  const files = [deps.files.out, deps.files.err].filter((f) => deps.fileExists(f));
  if (files.length === 0) {
    deps.out("No logs yet - this node has not run under the service.");
    deps.out("Start it with `dahrk start`, or check what it thinks it is doing with `dahrk status`.");
    deps.out("");
    deps.out("(A node run in a terminal with `--foreground` logs to that terminal, not to a file.)");
    return 0;
  }
  return deps.run(logsCommand({ files, lines: inputs.lines, follow: inputs.follow }));
}

/**
 * The `--run` / `--level` / `--json` mode: read `node.jsonl`, filter, print.
 *
 * `--follow` here shells out to `tail -f` on the raw JSONL rather than re-implementing follow. That is a
 * deliberate limitation, stated in the message rather than hidden: filtering a growing file properly
 * means a streaming parser, and the honest 90% answer is to hand the operator a `tail -f | jq` they can
 * see and adjust. Piping them a command beats pretending we filtered when we did not.
 */
async function runStructuredLogs(
  inputs: { lines: number; follow: boolean; level?: string | undefined; run?: string | undefined; json?: boolean },
  deps: LogsDeps,
): Promise<number> {
  if (!deps.fileExists(deps.jsonlFile)) {
    deps.out("No structured log yet - this node has not run since structured logging was added.");
    deps.out("Start it with `dahrk start`; it writes ~/.dahrk/logs/node.jsonl from the first boot.");
    return 0;
  }

  if (inputs.follow) {
    // Be straight about it rather than silently dropping the filters on the floor.
    deps.out("(--follow on the structured log streams it unfiltered; pipe it through jq to narrow it:)");
    deps.out(`  tail -f ${deps.jsonlFile} | jq -c 'select(.runId == "<runId>")'`);
    deps.out("");
    return deps.run(["tail", "-n", String(inputs.lines), "-f", deps.jsonlFile]);
  }

  const records = filterRecords(parseRecords(deps.readFile(deps.jsonlFile)), {
    level: inputs.level,
    run: inputs.run,
    lines: inputs.lines,
  });

  if (records.length === 0) {
    const narrowed = [inputs.run ? `run ${inputs.run}` : undefined, inputs.level ? `level ${inputs.level}+` : undefined]
      .filter(Boolean)
      .join(" at ");
    deps.out(narrowed ? `No records for ${narrowed}.` : "No records.");
    return 0;
  }

  for (const r of records) {
    if (inputs.json) deps.out(JSON.stringify(r));
    else for (const line of renderRecord(r)) deps.out(line);
  }
  return 0;
}

/**
 * Rotate a log file that has grown past `maxBytes`, keeping one previous generation (`.1`).
 *
 * The file is copied and then TRUNCATED IN PLACE - never renamed or unlinked. launchd and systemd open
 * these files themselves and hold the descriptor open for the life of the service: rename the file out
 * from under them and they keep happily writing to the now-nameless inode, so the log you can see stays
 * empty forever while the disk fills up. Truncating keeps the same inode, and because both open it
 * `O_APPEND`, the next write lands at offset 0. Called on node boot, which is the one moment we know
 * nothing is mid-write.
 */
export function rotateIfLarge(file: string, maxBytes: number = MAX_LOG_BYTES): void {
  try {
    if (!existsSync(file) || statSync(file).size <= maxBytes) return;
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
  } catch {
    // Rotation is housekeeping. If it fails (a read-only disk, a permissions oddity), the node must still
    // come up - a node that will not start because it could not tidy its logs is a worse outcome.
  }
}

export const defaultLogsDeps = (files: { out: string; err: string }, jsonlFile: string): LogsDeps => ({
  files,
  jsonlFile,
  fileExists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
  run: (argv) =>
    new Promise((resolve) => {
      const [cmd, ...args] = argv;
      const child = spawn(cmd as string, args, { stdio: "inherit" });
      // Ctrl-C on `logs -f` should end the tail and exit cleanly, not print a stack trace.
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 0));
    }),
  out: uiOut,
});
