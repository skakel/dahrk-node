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
import { copyFileSync, existsSync, statSync, truncateSync } from "node:fs";

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
  fileExists: (path: string) => boolean;
  /** Spawn tail, inheriting stdio, and resolve with its exit code. */
  run: (argv: string[]) => Promise<number>;
  out: (line: string) => void;
}

/**
 * Print (and optionally follow) the node's logs. Returns the process exit code.
 *
 * A node that has never run as a service has no log files, and `tail` would fail with a bare ENOENT that
 * says nothing useful. That is not an error - it is a node you have not started yet - so we say that
 * instead, and point at the command that explains why.
 */
export async function runLogs(
  inputs: { lines: number; follow: boolean },
  deps: LogsDeps,
): Promise<number> {
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

export const defaultLogsDeps = (files: { out: string; err: string }): LogsDeps => ({
  files,
  fileExists: (path) => existsSync(path),
  run: (argv) =>
    new Promise((resolve) => {
      const [cmd, ...args] = argv;
      const child = spawn(cmd as string, args, { stdio: "inherit" });
      // Ctrl-C on `logs -f` should end the tail and exit cleanly, not print a stack trace.
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 0));
    }),
  out: (line) => void process.stdout.write(`${line}\n`),
});
