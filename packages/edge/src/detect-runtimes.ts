/**
 * Runtime auto-detect. On boot a token-only edge probes which agent runtimes are actually
 * installed on the host and advertises only those, so the hub never routes a Job to a runtime the node
 * cannot run. Overridable: `apps/edge-node` uses the operator's `DAHRK_RUNTIMES` when set and only
 * falls back to this probe otherwise.
 *
 * The probe shells out to each runtime's CLI `--version` (the design-doc contract). Note the runner
 * adapters embed the vendor SDKs rather than the CLI, so a responding `--version` is a proxy for "this
 * runtime is installed and on PATH", which is the routing signal we want. A probe that errors, exits
 * non-zero, or times out is retried before it is treated as "not installed" - a single transient miss
 * (a cold Node CLI on a busy host) must not drop a working runtime from the advertisement (DHK-390);
 * only a command that is genuinely not on PATH is concluded absent without a retry.
 *
 * `probeRuntimeStatuses` returns the richer per-runtime status (installed + reported version) that
 * `dahrk doctor` prints; `detectRuntimes` is the thin routing view (just the installed set).
 */
import { execFile } from "node:child_process";
import type { Runtime } from "@dahrk/contracts";

/** One probe per runtime: the CLI to invoke and the `Runtime` it maps to. */
const PROBES: ReadonlyArray<{ runtime: Runtime; cmd: string }> = [
  { runtime: "claude-code", cmd: "claude" },
  { runtime: "pi", cmd: "pi" },
];

/** A runtime's install status as seen by the version probe. `version` is the trimmed first line of
 *  `<cmd> --version` (possibly `""` if the CLI printed nothing); it is absent iff `installed` is false. */
export interface RuntimeStatus {
  runtime: Runtime;
  cmd: string;
  installed: boolean;
  version?: string;
}

/** Default per-probe timeout. Raised from the original 3000ms: a cold Node-based CLI (`claude`, `pi`)
 *  on a host mid-IO-churn - e.g. right after an update-restart - can take longer than 3s to answer
 *  `--version`, and reading that as "not installed" is exactly the DHK-390 degradation. */
const DEFAULT_TIMEOUT_MS = 5000;

/** How many times to invoke a CLI before concluding it is absent. A single transient miss (a timed-out
 *  or spawn-hiccup probe on a busy host) must not delete a runtime from the advertisement, so we retry
 *  once. A CLI that is genuinely not on PATH (`ENOENT`) short-circuits without a retry - there is
 *  nothing to wait for - and a CLI that keeps erroring is still, correctly, not advertised. */
const DEFAULT_ATTEMPTS = 2;

/** One `<cmd> --version` invocation. Resolves the trimmed first non-empty output line on exit 0;
 *  otherwise `{ retryable }`, where `retryable` is false ONLY for `ENOENT` (the command is not on
 *  PATH, so no amount of retrying will find it). A timeout, spawn hiccup or non-zero exit is retryable:
 *  it may be transient. Never rejects. */
function probeOnce(cmd: string, timeoutMs: number): Promise<{ version: string } | { retryable: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, ["--version"], { timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return resolve({ retryable: code !== "ENOENT" });
      }
      const line = stdout.split("\n").map((s) => s.trim()).find(Boolean);
      resolve({ version: line ?? "" });
    });
  });
}

/** Probe `<cmd> --version`, retrying a transient failure before concluding absence. Resolves the
 *  reported version string on success, else `undefined` (genuinely not installed). Never rejects. */
async function probe(cmd: string, timeoutMs: number, attempts: number): Promise<string | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await probeOnce(cmd, timeoutMs);
    if ("version" in result) return result.version;
    // Not on PATH: definitively absent, so a retry would only add `attempts * timeoutMs` of latency.
    if (!result.retryable) return undefined;
  }
  return undefined; // retries exhausted: treat as absent
}

/**
 * Probe every candidate runtime concurrently and return each one's status in a stable order.
 * @param timeoutMs per-probe timeout (default {@link DEFAULT_TIMEOUT_MS}).
 * @param attempts invocations before concluding absence (default {@link DEFAULT_ATTEMPTS}); a single
 *   transient failure is retried so it cannot drop a working runtime from the advertisement.
 */
export async function probeRuntimeStatuses(
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = DEFAULT_ATTEMPTS,
): Promise<RuntimeStatus[]> {
  const versions = await Promise.all(PROBES.map((p) => probe(p.cmd, timeoutMs, attempts)));
  return PROBES.map((p, i) => {
    const version = versions[i];
    return version === undefined
      ? { runtime: p.runtime, cmd: p.cmd, installed: false }
      : { runtime: p.runtime, cmd: p.cmd, installed: true, version };
  });
}

/**
 * Probe every candidate runtime concurrently and return the ones that responded, in a stable order.
 * @param timeoutMs per-probe timeout (default {@link DEFAULT_TIMEOUT_MS}).
 * @param attempts invocations before concluding absence (default {@link DEFAULT_ATTEMPTS}).
 */
export async function detectRuntimes(
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = DEFAULT_ATTEMPTS,
): Promise<Runtime[]> {
  const statuses = await probeRuntimeStatuses(timeoutMs, attempts);
  return statuses.filter((s) => s.installed).map((s) => s.runtime);
}
