/**
 * The node's logger.
 *
 * Before this, the node's entire runtime log surface was one line - `process.stdout.write(line)` -
 * with no levels, no timestamps, no correlation ids, and no file. An incident on a node (ours or a
 * customer's) left nothing behind to read. This is the fix.
 *
 * ## Two sinks, two jobs
 *
 * - **stdout (the human plane).** Prints `msg` and *nothing else*: no timestamp, no level prefix, no
 *   fields. That is not laziness, it is a contract - `packages/edge/test/ws-client.test.ts` asserts
 *   `line.startsWith("JOB_STARTED:")`, and the harness greps these line-tagged markers to time a kill.
 *   Keeping the human line byte-identical to the old `log()` output means every marker survives at
 *   every level, and the structured detail simply lands in the other sink.
 * - **`~/.dahrk/logs/node.jsonl` (the forensic plane).** The full structured record: level, time,
 *   correlation ids, error stacks, and every field. Rotated, size-capped, scrubbed.
 *
 * ## The file sink defaults to `debug`, stdout to `info`
 *
 * This is the single most important choice here. Debug logging that you have to enable *before* the
 * incident is useless, because you only learn you needed it *after*. So the node always writes debug
 * detail to the file; `DAHRK_LOG_LEVEL` only governs how chatty stdout is. Disk cost is bounded by
 * rotation. When a node misbehaves, the evidence is already on disk.
 *
 * ## No transports, no worker threads
 *
 * pino's usual rotation story (`pino-roll`) is a transport, which spawns a worker thread and resolves
 * a module path at runtime. The published `dahrk` binary is a tsup bundle, where that is fragile. We
 * use `pino.multistream` with plain in-process sinks instead: no workers, nothing to resolve.
 *
 * The stdout sink deliberately goes through `process.stdout.write` rather than pino's default
 * `sonic-boom` fd-1 destination, because the tests intercept `process.stdout.write` and a direct fd
 * write would bypass them (and, in production, bypass any wrapper a supervisor installs).
 *
 * Everything logged is scrubbed (see `./redact.ts`) - the node holds SSH keys, git tokens and the
 * Anthropic session, and this file lands on disk and in support bundles.
 */
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { scrubValue } from "./redact.js";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

/** The logger the node passes around. Structurally a pino logger; named so call sites do not depend
 *  on pino's type surface (and so a future ring-1 telemetry sink can be added behind it). */
export type NodeLogger = pino.Logger;

export interface LoggerOptions {
  /** Level for the stdout (human) sink. Default `info`. */
  level?: LogLevel;
  /** Level for the JSONL file sink. Default `debug` - see the header. */
  fileLevel?: LogLevel;
  /** Directory for `node.jsonl`. Omit to disable the file sink entirely (stdout only). */
  dir?: string;
  /** Bound onto every record. */
  base?: Record<string, unknown>;
  /** Max bytes per log file before rotation. Default 10 MB. */
  maxBytes?: number;
  /** How many rotated files to keep (node.jsonl.1 ... .N). Default 5. */
  maxFiles?: number;
  /**
   * A third sink, for shipping records to the hub (`log-shipper.ts`).
   *
   * Registered at `trace` so the SHIPPER decides what to ship, not the logger: the hub can raise a node's
   * shipping level at runtime (the `policy` frame), and a logger-level filter here would silently cap it
   * at whatever the node happened to boot with. The shipper's own `shouldShip` is the gate, and it is the
   * one the operator can actually change.
   */
  ship?: { write(chunk: string): void };
}

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
const isLevel = (v: string | undefined): v is LogLevel => v !== undefined && (LEVELS as string[]).includes(v);

/** Resolve the stdout level from the environment. `DAHRK_LOG_LEVEL`, default `info`. */
export function levelFromEnv(env: NodeJS.ProcessEnv): LogLevel {
  const v = env.DAHRK_LOG_LEVEL?.toLowerCase();
  return isLevel(v) ? v : "info";
}

/** Resolve the file level. `DAHRK_LOG_FILE_LEVEL`, default `debug`. `DAHRK_LOG_FILE=0|off|false`
 *  disables the file sink (for containers where stdout is already captured and the disk is ephemeral). */
export function fileLevelFromEnv(env: NodeJS.ProcessEnv): LogLevel | "off" {
  const off = env.DAHRK_LOG_FILE?.toLowerCase();
  if (off === "0" || off === "off" || off === "false") return "off";
  const v = env.DAHRK_LOG_FILE_LEVEL?.toLowerCase();
  return isLevel(v) ? v : "debug";
}

/**
 * A size-rotating append-only file, written synchronously.
 *
 * Synchronous is the right trade here: the volume is low (a busy node logs tens of lines a second,
 * not thousands), and a crash must not lose the lines that explain it - an async buffer would drop
 * exactly the records we care most about.
 *
 * Every failure is swallowed after the first report. Logging must never be able to take a node down:
 * a full disk or a read-only `~/.dahrk` degrades us to stdout-only, it does not stop the node.
 */
class RotatingFile {
  private fd: number | undefined;
  private size = 0;
  private failed = false;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number,
  ) {
    this.open();
  }

  private open(): void {
    try {
      this.fd = openSync(this.path, "a");
      this.size = existsSync(this.path) ? statSync(this.path).size : 0;
    } catch (e) {
      this.disable(e);
    }
  }

  /** Report once, then go quiet. A logger that spams stderr about being unable to log is worse than one
   *  that silently degrades. */
  private disable(e: unknown): void {
    if (!this.failed) {
      this.failed = true;
      process.stderr.write(`dahrk: file logging disabled (${(e as Error).message})\n`);
    }
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        /* already gone */
      }
    }
    this.fd = undefined;
  }

  /** node.jsonl -> node.jsonl.1, .1 -> .2, ... dropping the oldest. */
  private rotate(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
      this.fd = undefined;
      const oldest = `${this.path}.${this.maxFiles}`;
      if (existsSync(oldest)) rmSync(oldest, { force: true });
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = `${this.path}.${i}`;
        if (existsSync(from)) renameSync(from, `${this.path}.${i + 1}`);
      }
      if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
      this.open();
    } catch (e) {
      this.disable(e);
    }
  }

  write(line: string): void {
    if (this.failed) return;
    if (this.fd === undefined) return;
    try {
      const buf = Buffer.from(line, "utf8");
      if (this.size > 0 && this.size + buf.length > this.maxBytes) {
        this.rotate();
        if (this.fd === undefined) return;
      }
      writeSync(this.fd, buf);
      this.size += buf.length;
    } catch (e) {
      this.disable(e);
    }
  }
}

/**
 * The stdout sink. pino hands every stream the serialised JSON line, so to print a human line we
 * parse it back out and write only `msg`. Cheap at our volume, and it keeps the marker contract exact.
 *
 * The write is guarded because **a logger must never throw**. If stdout has gone away - the classic case
 * being a pipe whose reader exited, `dahrk start | head` or `... | grep -m1 EDGE_WELCOMED` - then
 * `process.stdout.write` raises EPIPE. Unguarded, that surfaces as an uncaughtException, which the crash
 * handler dutifully tries to log... through this same sink, which EPIPEs again. The result is a crash
 * record (and a loop) caused by nothing worse than someone piping our output into `head`.
 */
const humanSink = {
  write(chunk: string): void {
    let msg: string;
    try {
      msg = (JSON.parse(chunk) as { msg?: string }).msg ?? "";
    } catch {
      msg = chunk.trimEnd(); // not JSON (should not happen); print it rather than lose it
    }
    if (!msg) return;
    try {
      process.stdout.write(`${msg}\n`);
    } catch {
      /* stdout is gone. Nothing to do, and nowhere to say so. The file sink still has the record. */
    }
  },
};

/**
 * Swallow EPIPE on stdout/stderr once per process.
 *
 * Belt to the guard's braces: on a pipe, EPIPE can also arrive asynchronously as an `error` event on the
 * stream rather than as a throw from `write`, and an unhandled `error` event is itself an
 * uncaughtException. `once` semantics via a module flag, so repeated `createNodeLogger` calls (tests) do
 * not pile up listeners and trip Node's max-listeners warning.
 */
let pipeGuardInstalled = false;
function guardBrokenPipe(): void {
  if (pipeGuardInstalled) return;
  pipeGuardInstalled = true;
  const ignoreEpipe = (err: NodeJS.ErrnoException): void => {
    if (err.code !== "EPIPE") throw err;
  };
  process.stdout.on("error", ignoreEpipe);
  process.stderr.on("error", ignoreEpipe);
}

/** Lowest of two levels, for the base logger (each sink then filters up to its own). */
function lowest(a: LogLevel, b: LogLevel): LogLevel {
  const rank = (l: LogLevel): number => LEVELS.indexOf(l);
  return rank(a) <= rank(b) ? a : b;
}

/**
 * Build the node's logger.
 *
 * The `hooks.logMethod` seam is where scrubbing happens: it sits on the single path every `log.info`,
 * `log.warn` etc. flows through, so there is no call site that can forget to scrub. Doing it here
 * rather than via pino's `redact` option is deliberate - `redact` only matches known key *paths*,
 * which is useless against a token embedded in a free-text git error, our dominant leak shape.
 */
export function createNodeLogger(opts: LoggerOptions = {}): NodeLogger {
  guardBrokenPipe();
  const level = opts.level ?? "info";
  const fileLevel = opts.fileLevel ?? "debug";
  const streams: pino.StreamEntry[] = [];

  // `silent` is a valid level for the logger as a whole but not for an individual sink, so a silenced
  // sink is simply not registered rather than registered at a level that cannot fire.
  if (level !== "silent") streams.push({ level, stream: humanSink });

  if (opts.dir && fileLevel !== "silent") {
    try {
      mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
      const file = new RotatingFile(join(opts.dir, "node.jsonl"), opts.maxBytes ?? 10 * 1024 * 1024, opts.maxFiles ?? 5);
      streams.push({ level: fileLevel, stream: file });
    } catch (e) {
      process.stderr.write(`dahrk: file logging disabled (${(e as Error).message})\n`);
    }
  }

  // Registered at `trace`, so the shipper is never starved by a logger-level filter it cannot change.
  if (opts.ship) streams.push({ level: "trace", stream: opts.ship });

  const base: pino.LevelWithSilent =
    streams.length === 0 ? "silent" : opts.ship ? "trace" : opts.dir ? lowest(level, fileLevel) : level;

  return pino(
    {
      level: base,
      base: opts.base ?? {},
      // ISO time reads better than epoch millis in a support bundle a human is scanning.
      timestamp: pino.stdTimeFunctions.isoTime,
      hooks: {
        logMethod(args, method) {
          method.apply(this, scrubValue(args) as Parameters<typeof method>);
        },
      },
    },
    pino.multistream(streams),
  );
}

/** Convenience: build the logger from the environment, the way `main.ts` and the CLI want it. */
export function createNodeLoggerFromEnv(
  env: NodeJS.ProcessEnv,
  dir: string,
  base?: Record<string, unknown>,
  ship?: { write(chunk: string): void },
): NodeLogger {
  const fileLevel = fileLevelFromEnv(env);
  return createNodeLogger({
    level: levelFromEnv(env),
    ...(fileLevel === "off" ? {} : { dir, fileLevel }),
    ...(base ? { base } : {}),
    ...(ship ? { ship } : {}),
  });
}
