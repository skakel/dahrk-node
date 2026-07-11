/**
 * The log-shipping sink: a third pino stream that batches records up to the hub, when - and only when -
 * the hub's telemetry policy permits it.
 *
 * ## The policy is a ceiling, not a floor
 *
 * The hub decides what a node MAY send (`TelemetryPolicy`, pushed on `welcome` and changeable
 * mid-session by the `policy` frame). A local `DAHRK_TELEMETRY=off` overrides it downward and can never
 * be overridden back up. That asymmetry is deliberate: this client is Apache-2.0 and the person running
 * it can read this file, so a hub that could force logs out of a machine against its operator's stated
 * wishes would be a lie anyone could catch us in. The hub can only ever ask for less than the operator
 * allows.
 *
 * ## Bounded, always
 *
 * A disconnected node must not queue logs forever - a node that loses its socket for an hour would OOM
 * on its own diagnostics, which is a spectacularly stupid way to lose a node. The buffer is a ring: when
 * it is full the OLDEST records are dropped and a counter is incremented, and the counter is reported,
 * because silently discarding a node's evidence recreates precisely the blindness this whole feature
 * exists to remove.
 *
 * Oldest-first is the right eviction here. A node in trouble emits a burst; the newest records describe
 * what it is doing NOW, which is what you are looking at the dashboard to find out.
 */
import { shouldShip, type LogShipLevel, type NodeLogRecord, type TelemetryPolicy } from "@dahrk/contracts";

/** How many records to hold when the socket is down or between flushes. */
export const SHIP_BUFFER_MAX = 500;
/** Max records in one `node-log` frame. Matches the hub's per-frame clamp, so we never send a batch it
 *  would only truncate. */
export const SHIP_BATCH_MAX = 200;
/** How often a non-empty buffer is flushed. Batched rather than per-record: a stage failing in a loop
 *  should cost one frame a second, not a frame a line. */
export const SHIP_FLUSH_MS = 2000;

export interface LogShipperOptions {
  /** The node's own default, before the hub says anything. Health on, logs off - the safe assumption for
   *  a node whose hub has not told it otherwise, and what an older hub (which sends no policy) implies. */
  initial?: TelemetryPolicy;
  /** Hard local ceiling from `DAHRK_TELEMETRY`. The hub can never exceed it. */
  ceiling?: TelemetryPolicy;
  flushMs?: number;
  bufferMax?: number;
}

/** Send a batch. Returns false if the socket is not open, in which case the shipper KEEPS the batch. */
export type ShipSend = (records: NodeLogRecord[]) => boolean;

export class LogShipper {
  private buffer: NodeLogRecord[] = [];
  private policy: TelemetryPolicy;
  private readonly ceiling: TelemetryPolicy;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Attached once the socket exists. The shipper is constructed FIRST, because it has to be a pino
   *  stream before the logger is built, which is before the client is started. Until `attach`, records
   *  simply accumulate in the (bounded) ring. */
  private send: ShipSend | undefined;
  /** Records we threw away because the buffer was full. Reported, never hidden. */
  dropped = 0;

  constructor(private readonly opts: LogShipperOptions = {}) {
    this.ceiling = opts.ceiling ?? { health: true, logs: "debug" };
    this.policy = this.clampToCeiling(opts.initial ?? { health: true, logs: "off" });
  }

  /** Give the shipper its transport. Called by the client once the socket exists. */
  attach(send: ShipSend): void {
    this.send = send;
  }

  /** The hub may only ever ask for LESS than the local ceiling allows. */
  private clampToCeiling(p: TelemetryPolicy): TelemetryPolicy {
    const rank: Record<LogShipLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };
    const logs = rank[p.logs] > rank[this.ceiling.logs] ? this.ceiling.logs : p.logs;
    return { health: p.health && this.ceiling.health, logs };
  }

  /** Apply a policy from the hub (`welcome`, or a live `policy` frame). */
  setPolicy(p: TelemetryPolicy): void {
    this.policy = this.clampToCeiling(p);
    // Turning shipping off discards what was queued. That is right: those records were gathered under a
    // permission that has just been withdrawn, and holding them in the hope it comes back is not our call.
    if (this.policy.logs === "off") this.buffer = [];
  }

  current(): TelemetryPolicy {
    return this.policy;
  }

  /** Offer a record. Cheap and synchronous - this sits on the logging hot path. */
  offer(record: NodeLogRecord): void {
    if (this.policy.logs === "off") return;
    if (!shouldShip(record.level, this.policy.logs)) return;

    this.buffer.push(record);
    if (this.buffer.length > (this.opts.bufferMax ?? SHIP_BUFFER_MAX)) {
      // Drop the OLDEST: a node in trouble emits a burst, and the newest lines say what it is doing now.
      this.buffer.shift();
      this.dropped++;
    }
  }

  /** Send one batch if there is anything to send and the socket will take it. */
  flush(): void {
    if (this.buffer.length === 0 || !this.send) return;
    const batch = this.buffer.slice(0, SHIP_BATCH_MAX);
    if (!this.send(batch)) return; // socket down: keep them, the ring bounds the wait
    this.buffer = this.buffer.slice(batch.length);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.opts.flushMs ?? SHIP_FLUSH_MS);
    // A pending log flush must never be the reason a node refuses to exit.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** For the health report and for tests. */
  pending(): number {
    return this.buffer.length;
  }
}

/**
 * The pino stream that feeds the shipper.
 *
 * pino hands every stream the serialised line, so we parse it back into the record shape the wire wants.
 * The node has already scrubbed credentials at write time (`redact.ts`) - so by the time a record reaches
 * here it is as safe as it is going to get. That is precisely why the scrubber had to come first: without
 * it, this stream would be a credential-exfiltration path with a nice API.
 */
export function shipperStream(shipper: LogShipper): { write(chunk: string): void } {
  return {
    write(chunk: string): void {
      try {
        const r = JSON.parse(chunk) as NodeLogRecord & { level: number; time: string; msg: string };
        if (!r.msg) return;
        shipper.offer({
          level: r.level,
          time: r.time,
          msg: r.msg,
          ...(r.runId ? { runId: r.runId } : {}),
          ...(r.stageId ? { stageId: r.stageId } : {}),
          ...(r.jobId ? { jobId: r.jobId } : {}),
          ...(r.component ? { component: r.component } : {}),
          ...(r.err ? { err: r.err } : {}),
        });
      } catch {
        /* an unparseable line is not worth shipping, and certainly not worth throwing over */
      }
    },
  };
}

/**
 * The operator's local ceiling, from `DAHRK_TELEMETRY`.
 *
 * - `off`    - nothing at all, not even health. The complete opt-out the privacy policy promises.
 * - `health` - health metadata only; never logs. Refuse the hub even if it asks.
 * - unset    - no local ceiling; the hub's policy applies as sent.
 */
export function ceilingFromEnv(env: NodeJS.ProcessEnv): TelemetryPolicy {
  const v = env.DAHRK_TELEMETRY?.toLowerCase();
  if (v === "off" || v === "0" || v === "false") return { health: false, logs: "off" };
  if (v === "health") return { health: true, logs: "off" };
  return { health: true, logs: "debug" }; // no local ceiling
}
