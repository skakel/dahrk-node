/**
 * Runtime auto-detect. On boot a token-only edge probes which agent runtimes are actually
 * installed on the host and advertises only those, so the hub never routes a Job to a runtime the node
 * cannot run. Overridable: `apps/edge-node` uses the operator's `DAHRK_RUNTIMES` when set and only
 * falls back to this probe otherwise.
 *
 * The probe shells out to each runtime's CLI `--version` (the design-doc contract). Note the runner
 * adapters embed the vendor SDKs rather than the CLI, so a responding `--version` is a proxy for "this
 * runtime is installed and on PATH", which is the routing signal we want. A probe that errors, exits
 * non-zero, or exceeds the timeout is treated as "not installed".
 *
 * `probeRuntimeStatuses` returns the richer per-runtime status (installed + reported version) that
 * `dahrk doctor` prints; `detectRuntimes` is the thin routing view (just the installed set).
 */
import { execFile } from "node:child_process";
import type { Runtime } from "@dahrk/contracts";

/** One probe per runtime: the CLI to invoke and the `Runtime` it maps to. */
const PROBES: ReadonlyArray<{ runtime: Runtime; cmd: string }> = [
  { runtime: "claude-code", cmd: "claude" },
  { runtime: "codex", cmd: "codex" },
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

/** Run `<cmd> --version`; resolve its trimmed first non-empty output line on exit 0, else `undefined`
 *  (not installed / errored / timed out). Never rejects. */
function probe(cmd: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, ["--version"], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(undefined);
      const line = stdout.split("\n").map((s) => s.trim()).find(Boolean);
      resolve(line ?? "");
    });
  });
}

/**
 * Probe every candidate runtime concurrently and return each one's status in a stable order.
 * @param timeoutMs per-probe timeout (default 3000).
 */
export async function probeRuntimeStatuses(timeoutMs = 3000): Promise<RuntimeStatus[]> {
  const versions = await Promise.all(PROBES.map((p) => probe(p.cmd, timeoutMs)));
  return PROBES.map((p, i) => {
    const version = versions[i];
    return version === undefined
      ? { runtime: p.runtime, cmd: p.cmd, installed: false }
      : { runtime: p.runtime, cmd: p.cmd, installed: true, version };
  });
}

/**
 * Probe every candidate runtime concurrently and return the ones that responded, in a stable order.
 * @param timeoutMs per-probe timeout (default 3000).
 */
export async function detectRuntimes(timeoutMs = 3000): Promise<Runtime[]> {
  const statuses = await probeRuntimeStatuses(timeoutMs);
  return statuses.filter((s) => s.installed).map((s) => s.runtime);
}
