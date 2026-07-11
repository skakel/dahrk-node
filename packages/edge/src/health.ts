/**
 * The node's self-report: what it tells the hub about its own condition, on every heartbeat.
 *
 * Before this the hub knew one thing about a node - that it pinged recently. It could not tell a healthy
 * node from one that was crash-looping, wedged on a stage, out of disk, or reconnecting every thirty
 * seconds under a process that looked fine. All of those were invisible, and all of them had bitten.
 *
 * ## What may go in here, and what may not
 *
 * This payload leaves machines we do not own. So the rule is absolute and structural, not a matter of
 * care: **numbers, enums, and a version string. Nothing else.** No file paths, no repo or branch names,
 * no command lines, no error messages, not even a hostname.
 *
 * That is the claim the published privacy policy makes on our behalf, and it is what lets us collect this
 * from a customer's laptop at all. If you find yourself wanting to add a field that would carry any of
 * those, it belongs in the log-shipping channel (`node-log`), which is policy-gated and defaults to off
 * on a machine we do not operate. Do not add it here and hope nobody notices; the classification in
 * `@dahrk/contracts` `data-classification.ts` is what a purge job and an auditor both read.
 *
 * Note the deliberate asymmetry with errors: we ship the COUNT of git failures, never the message. A
 * count tells you a node is failing to clone; the message would tell you which private repository it
 * failed to clone from.
 */
import { statfsSync } from "node:fs";
import type { NodeErrorClass, NodeHealth } from "@dahrk/contracts";

/**
 * Running tallies a node keeps for its own report. Cheap to update on the hot path (an increment), read
 * once every heartbeat.
 */
export class HealthCounters {
  private readonly startedAt = Date.now();
  private readonly errors = new Map<NodeErrorClass, number>();
  private crashes = 0;
  /** Connections made this process lifetime. The flapping signal: this climbing while uptime ALSO climbs
   *  means the socket keeps dropping under a process that is otherwise fine. */
  connectCount = 0;
  /** Jobs in flight. A node stuck at 1 for an hour is wedged, and nothing else reveals it. */
  activeJobs = 0;
  /** Worktrees on disk. Climbing without bound was the shape of the leak DHK-371 fixed. */
  worktreeCount = 0;

  /** Bucket a stage failure. The CLASS only - the message would carry their paths. */
  recordError(kind: NodeErrorClass): void {
    this.errors.set(kind, (this.errors.get(kind) ?? 0) + 1);
  }

  recordCrash(): void {
    this.crashes++;
  }

  uptimeSec(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  errorCounts(): Partial<Record<NodeErrorClass, number>> {
    return Object.fromEntries(this.errors) as Partial<Record<NodeErrorClass, number>>;
  }

  crashCount(): number {
    return this.crashes;
  }
}

/**
 * Free bytes on the volume that holds the worktrees.
 *
 * Best-effort: `statfs` is not available on every platform/filesystem we might land on, and a node that
 * refuses to report its health because it could not stat a disk would be a worse node than one that
 * reports everything else. A node that cannot clone is very often simply a node with a full disk, which
 * is exactly the sort of thing you want to see on a dashboard rather than deduce from a stack trace.
 */
export function diskFreeBytes(path: string): number | undefined {
  try {
    const st = statfsSync(path);
    return Number(st.bfree) * Number(st.bsize);
  } catch {
    return undefined;
  }
}

export interface HealthInputs {
  counters: HealthCounters;
  clientVersion: string;
  runtimes: string[];
  /** The worktree base, for the disk gauge. */
  worktreesDir: string;
}

/** Build the snapshot for a heartbeat. Called every `heartbeatMs` (5s), so it must stay cheap. */
export function collectHealth(inputs: HealthInputs): NodeHealth {
  const { counters } = inputs;
  const free = diskFreeBytes(inputs.worktreesDir);
  const errors = counters.errorCounts();

  return {
    uptimeSec: counters.uptimeSec(),
    clientVersion: inputs.clientVersion,
    activeJobs: counters.activeJobs,
    connectCount: counters.connectCount,
    worktreeCount: counters.worktreeCount,
    ...(free !== undefined ? { diskFreeBytes: free } : {}),
    runtimes: inputs.runtimes,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
    ...(counters.crashCount() > 0 ? { crashes: counters.crashCount() } : {}),
  };
}
