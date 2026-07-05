/**
 * Installable edge node entrypoint (Mac / VPS). The streamlined install is token-only:
 *
 *   dahrk start --token <enrolment-token>
 *
 * Everything else is either auto-detected on the node or pushed from the hub. On boot the node
 * probes which runtimes are installed (claude / codex / pi), reads or mints a stable node id
 * persisted under `~/.dahrk/node.json`, and dials OUT to the hub over WebSocket. It sends a `hello`
 * and the hub replies `welcome` with the node's tenant, display name, and policy (credential mode,
 * heartbeat, retention, allowed repos) - so the operator no longer hand-sets `DAHRK_TENANT_ID` or
 * `DAHRK_RUNTIMES`. No inbound ports; repos are cloned on demand from each Job's gitUrl.
 *
 * The CLI is subcommand-based (`start`, `doctor`, `help`, `version`), but `start` is the default so the
 * pre-subcommand invocation (`dahrk-node --token X`) still works. `dahrk doctor` runs a preflight
 * (Node version, runtimes, hub reachability, token validity) before you commit to `start`.
 *
 * Everything remains overridable for power users and the managed profile: `--token` / `--name` /
 * `--hub-url` flags win over the matching `DAHRK_*` env vars (the legacy `SKAKEL_*` names are still
 * accepted as aliases), and `DAHRK_RUNTIMES`, `DAHRK_CREDENTIAL_MODE`, `DAHRK_NODE_ID`,
 * `DAHRK_TENANT_ID` still act as explicit overrides.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { detectRuntimes, startEdgeNode, type EdgeOptions } from "@dahrk/edge";
import type { CredentialMode, Runtime } from "@dahrk/contracts";
import { parseCli, usage, type StartFlags } from "./cli.js";
import { runDoctor } from "./doctor.js";

const CLIENT_VERSION = process.env.npm_package_version ?? "0.0.0";

/** Canonical hosted hub; used when neither DAHRK_HUB_URL nor --hub-url is set. */
export const DEFAULT_HUB_URL = "wss://api.dahrk.ai";

const list = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const RUNTIMES: readonly Runtime[] = ["claude-code", "codex", "pi"];
const isRuntime = (r: string): r is Runtime => (RUNTIMES as readonly string[]).includes(r);

/** The async-resolved inputs `main` computes before building options: the persisted node id, the
 *  runtimes actually available (env override or auto-detect), and this build's version. Passed into
 *  `buildEdgeOptions` so that function stays pure and unit-testable without probing or touching disk. */
export interface ResolvedBoot {
  nodeId: string;
  runtimes: Runtime[];
  clientVersion: string;
}

/** Directory the node persists local state (its id) under. Overridable via DAHRK_STATE_DIR; defaults
 *  to `~/.dahrk` (the same home-dir convention as the git mirror cache). */
function stateDir(env: NodeJS.ProcessEnv): string {
  return env.DAHRK_STATE_DIR ?? join(homedir(), ".dahrk");
}

/** Legacy state dir from before the Dahrk rename; read (never written) so an existing node keeps its
 *  id across the upgrade. Only consulted when DAHRK_STATE_DIR is not set. */
function legacyStateDir(env: NodeJS.ProcessEnv): string | undefined {
  return env.DAHRK_STATE_DIR ? undefined : join(homedir(), ".skakel");
}

function readNodeId(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { nodeId?: unknown };
    if (typeof parsed.nodeId === "string" && parsed.nodeId) return parsed.nodeId;
  } catch {
    // Corrupt state file: fall through and re-mint.
  }
  return undefined;
}

/** Resolve this node's stable id. An explicit `DAHRK_NODE_ID` wins (the managed profile
 *  pins one); otherwise read `~/.dahrk/node.json` (falling back to the legacy `~/.skakel/node.json`
 *  so a pre-rename node keeps its id), minting and persisting a fresh UUID on first boot so the id
 *  survives restarts. A disk failure logs and falls back to an in-memory UUID. `ephemeral` skips all
 *  disk I/O and mints a throwaway id for this run (CI / one-shot nodes), unless an explicit
 *  `DAHRK_NODE_ID` still pins one. */
export function resolveNodeId(env: NodeJS.ProcessEnv, opts: { ephemeral?: boolean } = {}): string {
  if (env.DAHRK_NODE_ID) return env.DAHRK_NODE_ID;
  if (opts.ephemeral) return randomUUID();
  const dir = stateDir(env);
  const file = join(dir, "node.json");
  const existing = readNodeId(file);
  if (existing) return existing;
  const legacy = legacyStateDir(env);
  if (legacy) {
    const legacyId = readNodeId(join(legacy, "node.json"));
    if (legacyId) return legacyId;
  }
  const nodeId = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ nodeId }, null, 2)}\n`);
  } catch (e) {
    console.warn(`could not persist node id to ${file}: ${(e as Error).message}`);
  }
  return nodeId;
}

/** Resolve the runtimes this node advertises. `DAHRK_RUNTIMES` is an explicit override;
 *  otherwise auto-detect installed runtimes so the hub never routes a Job to one the node cannot run.
 *  The mock runner path (tests / local dev) skips probing since there are no CLIs to detect. */
export async function resolveRuntimes(env: NodeJS.ProcessEnv): Promise<Runtime[]> {
  const override = list(env.DAHRK_RUNTIMES).filter(isRuntime);
  if (override.length > 0) return override;
  if ((env.DAHRK_RUNNER ?? "real") === "mock") return ["claude-code"];
  return detectRuntimes();
}

/**
 * Translate the process env (plus the async-resolved boot inputs) into `EdgeOptions`. Pure and
 * exported so the env->options mapping can be unit-tested without dialing the hub or probing the host.
 * When `resolved` is omitted the legacy behaviour is preserved: runtimes default to `["claude-code"]`
 * and the node id / client version are left to the caller.
 */
export function buildEdgeOptions(env: NodeJS.ProcessEnv, resolved?: ResolvedBoot): EdgeOptions {
  // DAHRK_HUB_URL / --hub-url is now an override; unset falls back to the canonical hosted hub so the
  // token-only install needs just an enrolment token.
  const hubUrl = env.DAHRK_HUB_URL ?? DEFAULT_HUB_URL;
  // DAHRK_REPOS is now an OPTIONAL self-hosted allowlist of registry repoIds this node will serve
  // (a binding, not a definition); empty = serve any repo, cloning on demand (demoted from the
  // former list of pre-cloned local paths).
  const servesRepoIds = list(env.DAHRK_REPOS);
  // Credential mode is now pushed from the hub in `welcome`; `DAHRK_CREDENTIAL_MODE` is an explicit
  // override that is sent in `hello` only when the operator set it. Keep a resolved default for the
  // legacy advertise path.
  const credentialModeExplicit = env.DAHRK_CREDENTIAL_MODE != null;
  const credentialMode: CredentialMode =
    env.DAHRK_CREDENTIAL_MODE === "brokered" ? "brokered" : "ambient";
  // Runtimes: an explicit env list overrides; otherwise use the auto-detected set (may be empty, which
  // is the point - do not advertise a runtime the node cannot run). No `resolved` = legacy default.
  const envRuntimes = list(env.DAHRK_RUNTIMES).filter(isRuntime);
  const runtimes: Runtime[] = resolved
    ? resolved.runtimes
    : envRuntimes.length > 0
      ? envRuntimes
      : ["claude-code"];
  const nodeId = resolved?.nodeId ?? env.DAHRK_NODE_ID;

  // Worktree retention: prune finished runs' worktrees once they exceed a count or age.
  // Safe because their traces are streamed durably to the hub. Omitted = keep all (or hub default).
  const maxRuns = env.DAHRK_RETENTION_MAX_RUNS;
  const maxAgeMs = env.DAHRK_RETENTION_MAX_AGE_MS;
  const retention =
    maxRuns || maxAgeMs
      ? {
          ...(maxRuns ? { maxRuns: Number(maxRuns) } : {}),
          ...(maxAgeMs ? { maxAgeMs: Number(maxAgeMs) } : {}),
        }
      : undefined;

  return {
    hubUrl,
    ...(servesRepoIds.length > 0 ? { servesRepoIds } : {}),
    runtimes,
    credentialMode,
    credentialModeExplicit,
    // Identity: the persisted UUID (or an explicit id); the hub assigns a display name unless --name /
    // DAHRK_NODE_NAME overrides it.
    ...(nodeId ? { nodeId } : {}),
    ...(env.DAHRK_NODE_NAME ? { name: env.DAHRK_NODE_NAME } : {}),
    ...(resolved ? { clientVersion: resolved.clientVersion } : {}),
    // Enrolment token (required); tenant is derived hub-side from its pool.
    ...(env.DAHRK_ENROL_TOKEN ? { enrolToken: env.DAHRK_ENROL_TOKEN } : {}),
    // DAHRK_TENANT_ID is no longer required (tenant comes from `welcome`) but is still honoured as a
    // defence-in-depth override for the managed profile.
    ...(env.DAHRK_TENANT_ID ? { tenantId: env.DAHRK_TENANT_ID } : {}),
    worktreesDir: env.DAHRK_WORKTREES_DIR,
    mirrorsDir: env.DAHRK_MIRRORS_DIR,
    denyTool: env.DAHRK_DENY_TOOL,
    heartbeatMs: env.DAHRK_HEARTBEAT_MS ? Number(env.DAHRK_HEARTBEAT_MS) : undefined,
    ...(retention ? { retention } : {}),
  };
}

/** Populate each `DAHRK_*` var from its legacy `SKAKEL_*` alias when the new name is unset, so the
 *  pre-rename env still configures the node. Backward-compat shim; the `SKAKEL_*` fallback is dropped
 *  once deployments have migrated. */
function applyEnvAliases(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("SKAKEL_") && value !== undefined) {
      const dahrkKey = `DAHRK_${key.slice("SKAKEL_".length)}`;
      merged[dahrkKey] ??= value;
    }
  }
  return merged;
}

/** Overlay the parsed CLI flags onto a copy of the env; a flag wins over the matching env var. The
 *  legacy `SKAKEL_*` aliases are folded in first so a flag still beats them. */
function envWithFlags(env: NodeJS.ProcessEnv, flags: StartFlags): NodeJS.ProcessEnv {
  const merged = applyEnvAliases(env);
  if (flags.token) merged.DAHRK_ENROL_TOKEN = flags.token;
  if (flags.name) merged.DAHRK_NODE_NAME = flags.name;
  if (flags.hubUrl) merged.DAHRK_HUB_URL = flags.hubUrl;
  return merged;
}

/** Run the node: resolve identity + runtimes, then dial the hub and serve Jobs (blocks until exit). */
async function start(flags: StartFlags): Promise<void> {
  const env = envWithFlags(process.env, flags);
  const nodeId = resolveNodeId(env, { ephemeral: flags.ephemeral });
  const runtimes = await resolveRuntimes(env);
  if (runtimes.length === 0) {
    console.warn(
      "no agent runtimes detected on this host (claude/codex/pi not on PATH); the node will advertise " +
        "none and serve no Jobs. Install a runtime or set DAHRK_RUNTIMES to override. Run `dahrk doctor` to check.",
    );
  }
  const resolved: ResolvedBoot = { nodeId, runtimes, clientVersion: CLIENT_VERSION };
  await startEdgeNode(buildEdgeOptions(env, resolved));
}

/** Dispatch the CLI: `start` (default), `doctor`, `help`, `version`. Returns nothing for `start`
 *  (it blocks on the socket); the others print and let the caller exit. */
async function main(): Promise<void> {
  // The invoked program name for usage text. When run from source/dist the entry file is `main.*`,
  // which is meaningless to an operator, so fall back to the published bin name `dahrk`.
  const invoked = basename(process.argv[1] ?? "");
  const bin = !invoked || invoked.startsWith("main.") ? "dahrk" : invoked;
  const parsed = parseCli(process.argv.slice(2));
  switch (parsed.kind) {
    case "error":
      console.error(`${parsed.message}\n`);
      console.error(usage(bin));
      process.exit(2);
      break;
    case "help":
      console.log(usage(bin, parsed.command));
      break;
    case "version":
      console.log(CLIENT_VERSION);
      break;
    case "doctor": {
      const env = envWithFlags(process.env, parsed.flags);
      process.exitCode = await runDoctor({
        hubUrl: env.DAHRK_HUB_URL,
        token: env.DAHRK_ENROL_TOKEN,
        clientVersion: CLIENT_VERSION,
      });
      break;
    }
    case "start":
      await start(parsed.flags);
      break;
  }
}

// Only run the CLI when invoked as the process entrypoint; importing the module (e.g. from tests) is
// side-effect-free. Resolve argv[1] through any symlink first: an npm/Homebrew global install exposes
// the bin as a symlink, so the raw path never equals the real module URL and main() would silently
// never run (i.e. `dahrk --version` would print nothing).
const invokedAsEntrypoint = ((): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (invokedAsEntrypoint) {
  main().catch((err: unknown) => {
    // A fatal enrolment rejection (bad/missing token) rejects startEdgeNode before it ever connects.
    // The edge already set process.exitCode (78 = EX_CONFIG) so pm2 can stop rather than
    // crash-loop; surface the message and exit with that code instead of a generic unhandled-rejection 1.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(process.exitCode || 1);
  });
}
