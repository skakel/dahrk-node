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
}

const STRING_FIELDS = ["nodeId", "enrolToken", "name", "tenantId"] as const;

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
