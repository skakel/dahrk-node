/**
 * The node's local state file (`~/.dahrk/node.json`), which holds the two things a node must
 * remember between boots: its stable `nodeId` and the enrolment token it was accepted with.
 *
 * The token is persisted so enrolment is a ONE-TIME act. `dahrk start --token <t>` enrols; every
 * later bare `dahrk start` (or a reboot, or a service restart) re-attaches with the token from disk
 * instead of failing with `EDGE_REJECTED:4400 an enrolment token is required`. That is sound because
 * the token is a reusable pool-join token, not a one-shot: the wire contract requires `enrolToken` on
 * every `hello`, and the client already re-sends the same one on every reconnect.
 *
 * It is only written once the hub has actually WELCOMED the token (see `onEnrolled` in the edge
 * client), so a typo'd token is never cached and a later bare `start` can never fail against a
 * credential the hub already rejected.
 *
 * The file holds a secret, so it is written 0600 inside a 0700 directory. The mode is re-applied on
 * every write: a node.json minted by an older client (which stored only the id, and left it
 * world-readable at 0644) is tightened the first time we persist a token into it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "@dahrk/contracts";

const RUNTIMES: readonly Runtime[] = ["claude-code", "codex", "pi"];
const isRuntime = (v: unknown): v is Runtime => (RUNTIMES as readonly unknown[]).includes(v);

/** What `~/.dahrk/node.json` holds. Every field is optional: an older client wrote only `nodeId`, and
 *  the hub-assigned identity is only known once a `welcome` has landed. */
export interface NodeState {
  nodeId?: string;
  enrolToken?: string;
  /** The display name the hub assigned at the last welcome. Cached so `dahrk status` can name the node
   *  offline, without dialling the hub. Observability only - never sent back, never control flow. */
  name?: string;
  /** The tenant the hub bound this node to at the last welcome (cached for `status`, as above). */
  tenantId?: string;
  /** The runtime set this node advertised on its last boot. Persisted so the next boot can tell a
   *  runtime that has DISAPPEARED (was advertised, is not detected now) from one that was never there,
   *  and warn loudly about the former - the silent degradation DHK-390 was about. */
  runtimes?: Runtime[];
  /** Whether the operator wants this node running: `dahrk start` writes "running", `dahrk stop` writes
   *  "stopped". It records INTENT, which the supervisor cannot tell us: a unit that is installed but not
   *  running is either crash-looping (broken, worth shouting about) or deliberately stopped (fine). Without
   *  this, `status` cannot tell those apart and its exit code would report a stopped node as unhealthy. */
  desired?: DesiredState;
  /** When the update check last ran (ISO-8601), and the newest version it saw. Cached so the check runs at
   *  most daily rather than on every start (a crash-looping daemon would otherwise hammer the registry),
   *  and so `dahrk status` can report an available update WITHOUT dialling anything - its whole contract is
   *  that it works offline. */
  updateCheckedAt?: string;
  updateLatest?: string;
}

/** Does the operator want this node up? See `NodeState.desired`. */
export type DesiredState = "running" | "stopped";

const STRING_FIELDS = ["nodeId", "enrolToken", "name", "tenantId", "updateCheckedAt", "updateLatest"] as const;

/** `desired` is the one field with a closed set of values, so it is validated rather than copied: an
 *  unrecognised value (a hand-edited file, a future client) reads as absent, which falls back to the
 *  safe default of "assume it should be running". */
const isDesired = (v: unknown): v is DesiredState => v === "running" || v === "stopped";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Directory the node persists local state under. Overridable via DAHRK_STATE_DIR; defaults to
 *  `~/.dahrk` (the same home-dir convention as the git mirror cache). */
export function stateDir(env: NodeJS.ProcessEnv): string {
  return env.DAHRK_STATE_DIR ?? join(homedir(), ".dahrk");
}

/** Legacy state dir from before the Dahrk rename; read (never written) so an existing node keeps its
 *  id across the upgrade. Only consulted when DAHRK_STATE_DIR is not set. */
export function legacyStateDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.DAHRK_STATE_DIR ? undefined : join(homedir(), ".skakel");
}

export function stateFile(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "node.json");
}

/** Where the node's stdout/stderr land when it runs under a supervisor. Both launchd and systemd are
 *  pointed at these files (systemd via `StandardOutput=append:`), so `dahrk logs` is one code path on
 *  every host rather than "tail a file on macOS, journalctl on Linux".
 *
 *  This lives here, next to `stateDir`, because it was previously derived in two places that disagreed:
 *  `service.ts` honoured DAHRK_STATE_DIR while `status.ts` hardcoded `~/.dahrk/logs`, so a node with a
 *  custom state dir was told to tail a file that would never exist. One definition, no drift. */
export function logDir(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "logs");
}

/** The two log files, out first: `EDGE_CONNECTED` and the Job markers go to stdout, so a `logs` that
 *  showed only stderr would look silent on a perfectly healthy node. */
export function logFiles(env: NodeJS.ProcessEnv): { out: string; err: string } {
  const dir = logDir(env);
  return { out: join(dir, "node.out.log"), err: join(dir, "node.err.log") };
}

/** The structured log the node writes itself (`node.jsonl`), as opposed to `node.{out,err}.log`, which
 *  are whatever the SUPERVISOR captured from our stdout/stderr.
 *
 *  Two files, two jobs. The `.log` pair is the human transcript - the line-tagged markers, as printed.
 *  This one is the forensic record: one JSON object per line, with levels, timestamps, correlation ids
 *  (runId/stageId/jobId) and error stacks, written at `debug` even when stdout is at `info`. It is what
 *  `dahrk logs --run <id>` reads and what `dahrk diagnose` collects. It rotates itself (see the logger),
 *  so unlike the `.log` pair it needs no boot-time `rotateIfLarge`. */
export function jsonlLogFile(env: NodeJS.ProcessEnv): string {
  return join(logDir(env), "node.jsonl");
}

/** Where crash records land. Separate from the log because the log rotates: a crash-loop can push its own
 *  first cause out of the JSONL, and the first cause is the one worth having. */
export function crashDir(env: NodeJS.ProcessEnv): string {
  return join(logDir(env), "crashes");
}

/** The pidfile the foreground worker holds for as long as it is running. It is what stops a second node
 *  dialling the hub with the SAME persisted nodeId - see `lock.ts`. */
export function lockFile(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "node.pid");
}

/** Record whether the operator wants this node up. `start` sets "running", `stop` sets "stopped"; `status`
 *  reads it to tell a crash-loop from a deliberate stop. */
export function setDesired(env: NodeJS.ProcessEnv, desired: DesiredState): void {
  writeState(env, { desired });
}

/** Read a state file. A missing or corrupt file reads as empty state (the caller re-mints), so a
 *  half-written node.json can never wedge a boot. */
export function readState(file: string): NodeState {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const state: NodeState = {};
    for (const key of STRING_FIELDS) {
      const value = parsed[key];
      if (typeof value === "string" && value) state[key] = value;
    }
    if (isDesired(parsed["desired"])) state.desired = parsed["desired"];
    // Keep only the recognised runtime ids, so a hand-edited or future-client value cannot smuggle a
    // bogus runtime into the disappearance diff.
    if (Array.isArray(parsed["runtimes"])) {
      const runtimes = parsed["runtimes"].filter(isRuntime);
      if (runtimes.length) state.runtimes = runtimes;
    }
    return state;
  } catch {
    return {};
  }
}

/** Merge `patch` into the state file, preserving the fields it does not mention (persisting a token
 *  must never drop the node id, and vice versa). Best-effort: a disk failure warns and is swallowed,
 *  since losing the cache degrades the next boot to "pass --token again" rather than breaking this one. */
export function writeState(env: NodeJS.ProcessEnv, patch: NodeState): void {
  const dir = stateDir(env);
  const file = stateFile(env);
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const next = { ...readState(file), ...patch };
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: FILE_MODE });
    // writeFileSync's `mode` only applies when it CREATES the file, so an existing 0644 node.json from
    // an older client keeps its mode. Tighten it explicitly now that it holds a token.
    chmodSync(file, FILE_MODE);
  } catch (e) {
    console.warn(`could not persist node state to ${file}: ${(e as Error).message}`);
  }
}

/** The enrolment token cached from a previous successful enrolment, if any. */
export function readPersistedToken(env: NodeJS.ProcessEnv): string | undefined {
  return readState(stateFile(env)).enrolToken;
}

/** Cache what the hub just welcomed us with: the token (so the next bare `dahrk start` re-attaches
 *  without it) and the identity it assigned us (so `dahrk status` can name the node without dialling).
 *
 *  A no-op when all of it already matches what is on disk, so the reconnect loop - which welcomes
 *  again on every drop - does no IO in the steady state. */
export function persistEnrolment(
  env: NodeJS.ProcessEnv,
  enrolment: { token: string; name?: string; tenantId?: string },
): void {
  const { token, name, tenantId } = enrolment;
  if (!token) return;
  const current = readState(stateFile(env));
  const unchanged =
    current.enrolToken === token &&
    (name === undefined || current.name === name) &&
    (tenantId === undefined || current.tenantId === tenantId);
  if (unchanged) return;
  writeState(env, {
    enrolToken: token,
    ...(name ? { name } : {}),
    ...(tenantId ? { tenantId } : {}),
  });
}

/** Resolve the enrolment token to present to the hub: an explicit `--token` / `DAHRK_ENROL_TOKEN`
 *  wins, otherwise fall back to the token cached by the last successful enrolment. `ephemeral` skips
 *  the disk entirely (CI / one-shot nodes bring their own token or none). */
export function resolveEnrolToken(
  env: NodeJS.ProcessEnv,
  opts: { ephemeral?: boolean } = {},
): string | undefined {
  if (env.DAHRK_ENROL_TOKEN) return env.DAHRK_ENROL_TOKEN;
  if (opts.ephemeral) return undefined;
  return readPersistedToken(env);
}
