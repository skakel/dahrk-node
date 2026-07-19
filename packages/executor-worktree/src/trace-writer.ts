/**
 * The trace producer (minimal, M3). Writes the normalised trace envelope for one
 * stage attempt under `.dahrk/scratch/traces/<stageId>/attempt-<n>/`:
 *   - `trace.jsonl` - one normalised TraceEvent per line, append-only, grep-friendly;
 *   - `meta.json`   - the single TraceMeta, written at start and finalised at exit;
 *   - `blobs/<sha256>` - large payloads spilled out of the JSONL, referenced by the
 *     event's `*Ref` field, never truncated.
 *
 * M4's real adapters feed this from their native streams (the Claude adapter via
 * cyrus's AgentSessionManager mapping); M3 feeds it from the mock runner.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TraceEvent, TraceMeta } from "@dahrk/contracts";

const DEFAULT_SPILL_BYTES = 8192;

export interface TraceWriter {
  /** The attempt directory the trace is written under. */
  readonly dir: string;
  /** Append one normalised event (spilling large payloads to blobs/). Returns the event
   *  exactly as written - with its assigned `seq` and any `*Ref` spill applied - so a
   *  caller streaming the trace persists the identical record. */
  append(event: TraceEvent): TraceEvent;
  /**
   * Persist a runtime-native record under `raw/` and return its `rawRef` (e.g. `raw/3.json`),
   * so an adapter can cite the source message it normalised an event from. Real adapters
   * (M4) call this once per native SDK message; the mock does not write raw.
   */
  writeRaw(record: unknown): string;
  /** Merge a patch into meta.json (status, endedAt, usage, ...) at stage exit. */
  finalise(patch?: Partial<TraceMeta>): void;
  /** The number of events appended so far (the authoritative count for reconciliation). */
  count(): number;
}

export function createTraceWriter(
  scratchPath: string,
  meta: TraceMeta,
  opts: { spillBytes?: number } = {},
): TraceWriter {
  const spillBytes = opts.spillBytes ?? DEFAULT_SPILL_BYTES;
  const dir = join(scratchPath, "traces", meta.stageId, `attempt-${meta.attempt}`);
  mkdirSync(join(dir, "blobs"), { recursive: true });
  mkdirSync(join(dir, "raw"), { recursive: true });
  const tracePath = join(dir, "trace.jsonl");
  const metaPath = join(dir, "meta.json");

  let current: TraceMeta = { ...meta };
  let nextSeq = 0; // the writer owns seq: monotonic in append order within the attempt
  let rawCount = 0; // the writer owns the raw-sidecar index, monotonic in write order
  writeFileSync(metaPath, JSON.stringify(current, null, 2));

  const tooBig = (value: unknown): boolean => {
    const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
    return s.length > spillBytes;
  };
  const spillValue = (value: unknown): string => {
    const data = typeof value === "string" ? value : JSON.stringify(value);
    const sha = createHash("sha256").update(data).digest("hex");
    writeFileSync(join(dir, "blobs", sha), data);
    return join("blobs", sha);
  };

  /** Move an over-threshold payload into blobs/ and reference it by the *Ref variant. */
  const spill = (event: TraceEvent): TraceEvent => {
    if (event.type === "thought" && event.text !== undefined && tooBig(event.text)) {
      const { text, ...rest } = event;
      return { ...rest, textRef: spillValue(text) };
    }
    if (event.type === "response" && event.text !== undefined && tooBig(event.text)) {
      const { text, ...rest } = event;
      return { ...rest, textRef: spillValue(text) };
    }
    if (event.type === "action" && event.input !== undefined && tooBig(event.input)) {
      const { input, ...rest } = event;
      return { ...rest, inputRef: spillValue(input) };
    }
    if (event.type === "observation" && event.output !== undefined && tooBig(event.output)) {
      const { output, ...rest } = event;
      return { ...rest, outputRef: spillValue(output) };
    }
    return event;
  };

  return {
    dir,
    append(event) {
      // The writer assigns seq in append order, so injected events (e.g. policy-deny)
      // interleave correctly with runner-emitted ones.
      const written = { ...spill(event), seq: nextSeq++ } as TraceEvent;
      appendFileSync(tracePath, `${JSON.stringify(written)}\n`);
      return written;
    },
    writeRaw(record) {
      const rel = join("raw", `${rawCount++}.json`);
      writeFileSync(join(dir, rel), JSON.stringify(record, null, 2));
      return rel;
    },
    finalise(patch = {}) {
      current = { ...current, ...patch };
      writeFileSync(metaPath, JSON.stringify(current, null, 2));
    },
    count() {
      return nextSeq;
    },
  };
}
