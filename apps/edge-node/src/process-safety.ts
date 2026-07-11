/**
 * Process-level safety net for the node.
 *
 * The node had none. `main().catch()` printed `err.message` and threw the stack away, and there were no
 * `uncaughtException` / `unhandledRejection` handlers at all - so under Node 22's default
 * (`--unhandled-rejections=throw`) a single stray rejection from any of the node's many best-effort
 * background paths (trace shipping, blob upload, retention, WS message handling) killed the process
 * outright, leaving one line of stderr and no stack.
 *
 * That is expensive in a way it is not for a stateless server. When a node dies mid-stage it loses the
 * in-memory `lastResults` map that re-sends finished-but-unacknowledged results on reconnect, so the
 * hub's run can wedge until its dispatch deadline re-arms. A stray rejection in a fire-and-forget
 * `.catch()` seam is a bad reason to pay that.
 *
 * **Policy: log and survive** - the same call the hub makes (`packages/hub/src/process-safety.ts`), and
 * for the same reason: in this process the realistic source of both classes is a background callback,
 * not a corrupted core. We log loudly (full stack) and write a crash record, so nothing is hidden and
 * real bugs stay visible. This deliberately does NOT replace the individual `.catch()` seams; it is the
 * net under them.
 *
 * Set `DAHRK_CRASH_EXIT=1` to opt out and let the process die on an uncaught exception instead - the
 * right choice if you would rather a supervisor restart a node than let it limp.
 *
 * The crash record (`~/.dahrk/logs/crashes/<iso>.json`) is the artefact `dahrk diagnose` collects. It
 * exists because the JSONL log rotates: a crash-loop can push its own first cause out of the log, and
 * the first cause is the one you need.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeLogger } from "@dahrk/edge";

/** What we write to `crashes/<iso>.json`. Deliberately small and all harness metadata: no job payload,
 *  no issue content, no repo paths beyond what a stack frame already carries. */
export interface CrashRecord {
  at: string;
  kind: "uncaughtException" | "unhandledRejection";
  name: string;
  message: string;
  stack?: string;
  clientVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  uptimeSec: number;
  /** Jobs in flight when it died - the run(s) that will wedge, so you know where to look hub-side. */
  activeJobIds?: string[];
}

export interface ProcessSafetyNet {
  uninstall: () => void;
}

export interface SafetyNetOptions {
  logger: NodeLogger;
  /** Directory for crash records. Omit to skip writing them (log only). */
  crashDir?: string;
  clientVersion: string;
  /** Read at crash time, so the record names the runs that are about to wedge. */
  activeJobIds?: () => string[];
  /** Exit on an uncaught exception instead of surviving it. `DAHRK_CRASH_EXIT=1`. */
  exitOnCrash?: boolean;
}

/** Write the crash record. Never throws: failing to record a crash must not cause a second one. */
export function writeCrashRecord(dir: string, record: CrashRecord): string | undefined {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `:` is legal on the platforms we target but awkward in a filename; keep it sortable and shell-safe.
    const file = join(dir, `${record.at.replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return file;
  } catch {
    return undefined;
  }
}

/** Build the record from whatever was thrown. `reason` is `unknown` because a rejection can carry
 *  anything at all - a string, `undefined`, an object that is not an Error. */
function toRecord(kind: CrashRecord["kind"], reason: unknown, opts: SafetyNetOptions): CrashRecord {
  const err = reason instanceof Error ? reason : undefined;
  return {
    at: new Date().toISOString(),
    kind,
    name: err?.name ?? typeof reason,
    message: err?.message ?? String(reason),
    ...(err?.stack ? { stack: err.stack } : {}),
    clientVersion: opts.clientVersion,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeSec: Math.round(process.uptime()),
    ...(opts.activeJobIds ? { activeJobIds: opts.activeJobIds() } : {}),
  };
}

/**
 * What we do when something is thrown: record it, log it, and (by default) carry on.
 *
 * Built separately from `installProcessSafetyNet` so it can be tested without registering a real
 * process listener. That is not merely convenient: `node:test` installs its own `unhandledRejection`
 * listener and fails the test on any real rejection, so the live event is untestable from inside a test.
 * Keeping the policy here and the registration there means the policy is exercised directly.
 */
export function makeCrashHandlers(opts: SafetyNetOptions): {
  onUnhandledRejection: (reason: unknown) => void;
  onUncaughtException: (err: unknown) => void;
} {
  const handle = (kind: CrashRecord["kind"], reason: unknown): void => {
    const record = toRecord(kind, reason, opts);
    const file = opts.crashDir ? writeCrashRecord(opts.crashDir, record) : undefined;
    // `err` gives pino the stack (scrubbed on the way out); `crashFile` points at the durable copy.
    opts.logger.error(
      { err: reason, kind, ...(file ? { crashFile: file } : {}), activeJobIds: record.activeJobIds },
      `NODE_CRASH:${kind} ${record.name}: ${record.message}`,
    );
  };

  return {
    onUnhandledRejection: (reason) => handle("unhandledRejection", reason),
    onUncaughtException: (err) => {
      handle("uncaughtException", err);
      if (opts.exitOnCrash) process.exit(1);
    },
  };
}

/**
 * Install the top-level handlers. Returns a handle so tests can remove them again (a leaked handler
 * across suites would swallow the next test's failures).
 */
export function installProcessSafetyNet(opts: SafetyNetOptions): ProcessSafetyNet {
  const { onUnhandledRejection, onUncaughtException } = makeCrashHandlers(opts);

  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);

  return {
    uninstall: () => {
      process.off("unhandledRejection", onUnhandledRejection);
      process.off("uncaughtException", onUncaughtException);
    },
  };
}
