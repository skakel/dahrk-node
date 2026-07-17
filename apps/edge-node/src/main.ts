/**
 * Installable edge node entrypoint (Mac / VPS). The streamlined install is token-only:
 *
 *   dahrk start --token <enrolment-token>
 *
 * The token is needed ONCE. On a successful enrolment it is cached (0600) alongside the node id in
 * `~/.dahrk/node.json`, so every later `dahrk start` - and every reboot, and the installed service -
 * re-attaches as the same node with no `--token`. Pass one again only to re-enrol (a rotated token, or
 * a move to another pool); `--ephemeral` opts out of the disk entirely.
 *
 * Everything else is either auto-detected on the node or pushed from the hub. On boot the node
 * probes which runtimes are installed (claude / codex / pi), reads or mints a stable node id
 * persisted under `~/.dahrk/node.json`, and dials OUT to the hub over WebSocket. It sends a `hello`
 * and the hub replies `welcome` with the node's tenant, display name, and policy (credential mode,
 * heartbeat, retention, allowed repos) - so the operator no longer hand-sets `DAHRK_TENANT_ID` or
 * `DAHRK_RUNTIMES`. No inbound ports; repos are cloned on demand from each Job's gitUrl.
 *
 * The CLI is subcommand-based (`start`, `run`, `doctor`, `update`, `help`, `version`), but `start` is the
 * default so the pre-subcommand invocation (`dahrk-node --token X`) still works. `dahrk doctor` runs a
 * preflight (Node version, runtimes, hub reachability, token validity) before you commit to `start`, and
 * `dahrk update` self-updates the client in place to the latest published release.
 *
 * Everything remains overridable for power users and the managed profile: `--token` / `--name` /
 * `--hub-url` flags win over the matching `DAHRK_*` env vars (the legacy `SKAKEL_*` names are still
 * accepted as aliases), and `DAHRK_RUNTIMES`, `DAHRK_CREDENTIAL_MODE`, `DAHRK_NODE_ID`,
 * `DAHRK_TENANT_ID` still act as explicit overrides.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, platform as osPlatform } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ceilingFromEnv,
  createNodeLoggerFromEnv,
  detectRuntimes,
  ENROLMENT_REJECTED_EXIT_CODE,
  fileJobLedger,
  jobLedgerFile,
  LogShipper,
  probeHub,
  probeRuntimeStatuses,
  shipperStream,
  startEdgeNode,
  type EdgeOptions,
} from "@dahrk/edge";
import type { CredentialMode, Runtime } from "@dahrk/contracts";
import { parseCli, usage, type RepoAddFlags, type RunFlags, type StartFlags } from "./cli.js";
import { runDiagnose, defaultDiagnoseDeps, defaultBundlePath } from "./diagnose.js";
import { runDoctor } from "./doctor.js";
import {
  chooseGitUrl,
  deriveRepoId,
  deriveRepoName,
  hubHttpBase,
  parseGitRemote,
  registerRepo,
  type RepoFacts,
} from "./repo-add.js";
import { defaultLockDeps, acquireLock, isAlive, parseLock } from "./lock.js";
import { defaultLogsDeps, parseRecords, rotateIfLarge, runLogs } from "./logs.js";
import { installProcessSafetyNet, writeCrashRecord } from "./process-safety.js";
import { probeRepo, runPreflight, sshKeyPresent } from "./preflight.js";
import {
  runNodeRestart,
  runNodeStart,
  runNodeStop,
  runServiceInstall,
  runServiceUninstall,
  STOP_FOREIGN_NODE,
} from "./service.js";
import { fetchLatestVersion, runUpdate, type UpdateDeps } from "./update.js";
import { confirm, hint, isInteractive, kv, out as uiOut, stripAnsi, verdict } from "./ui.js";
import {
  checkForUpdate,
  checkIntervalMs,
  checkSuppressed,
  jitterMs,
  renderUpdateLogLine,
  renderUpdateNotice,
  type UpdateCheckDeps,
} from "./update-check.js";
import { lastConnection, runStatus, type StatusDeps } from "./status.js";
import {
  crashDir,
  jsonlLogFile,
  legacyStateDir,
  lockFile,
  logDir,
  logFiles,
  persistEnrolment,
  readPersistedToken,
  readState,
  resolveEnrolToken,
  setDesired,
  stateDir,
  stateFile,
  writeState,
} from "./state.js";

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

/** Resolve this node's stable id. An explicit `DAHRK_NODE_ID` wins (the managed profile
 *  pins one); otherwise read `~/.dahrk/node.json` (falling back to the legacy `~/.skakel/node.json`
 *  so a pre-rename node keeps its id), minting and persisting a fresh UUID on first boot so the id
 *  survives restarts. A disk failure logs and falls back to an in-memory UUID. `ephemeral` skips all
 *  disk I/O and mints a throwaway id for this run (CI / one-shot nodes), unless an explicit
 *  `DAHRK_NODE_ID` still pins one. */
export function resolveNodeId(env: NodeJS.ProcessEnv, opts: { ephemeral?: boolean } = {}): string {
  if (env.DAHRK_NODE_ID) return env.DAHRK_NODE_ID;
  if (opts.ephemeral) return randomUUID();
  const existing = readState(stateFile(env)).nodeId;
  if (existing) return existing;
  const legacy = legacyStateDir(env);
  if (legacy) {
    const legacyId = readState(join(legacy, "node.json")).nodeId;
    if (legacyId) return legacyId;
  }
  const nodeId = randomUUID();
  writeState(env, { nodeId });
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

/** Should this invocation run the worker in-process rather than hand the node to a supervisor?
 *
 *  `DAHRK_SUPERVISED` is set by the unit we install, alongside the `--foreground` in its argv: a supervised
 *  process MUST run the worker, because "ensure the node is running" is exactly what its supervisor is
 *  already doing - it would see itself running, exit, and be restarted into the same no-op forever.
 *  `DAHRK_FOREGROUND` is the operator's own spelling of `--foreground`, for a Dockerfile or a pm2 config
 *  where setting an env var is easier than threading an argument. */
function wantsForeground(env: NodeJS.ProcessEnv, flags: StartFlags): boolean {
  return flags.foreground || env.DAHRK_FOREGROUND === "1" || env.DAHRK_SUPERVISED === "1";
}

/** `dahrk start`: make the node run, and come back. Installs (or repairs) the service, starts it, and
 *  returns - unless this host cannot supervise anything, or the operator asked for the worker directly, in
 *  which case we run it here and block. */
async function start(flags: StartFlags): Promise<number> {
  const env = envWithFlags(process.env, flags);
  if (wantsForeground(env, flags)) return startForeground(env, flags);

  // The unit we are about to write carries no token, so the daemon will read it from `node.json`. Getting
  // it there is therefore part of starting, not a side effect of the first successful connect.
  const enrolled = await enrolToDisk(env);
  if (enrolled !== 0) return enrolled;

  // `--no-service`: the operator supervises the node themselves (a container, pm2, their own unit), so we
  // enrol - the token is now on disk - but stop short of installing the always-on service. This is the
  // opt-out `install.sh --no-service` forwards to.
  if (flags.noService) {
    uiOut("");
    uiOut(verdict("ok", "Enrolled. Not installing a service (--no-service)."));
    uiOut(hint("Run the node with `dahrk start --foreground` (or your own supervisor), or `dahrk start` to install the service."));
    return 0;
  }

  // Interactive only: the operator is here, at a prompt, about to commit to running this version for
  // months. It is the one good moment to mention there is a newer one.
  await offerUpdate(env);

  const outcome = await runNodeStart(serviceInputs(env));

  if (outcome.kind === "error") return outcome.code;
  if (outcome.kind === "running") {
    setDesired(env, "running");
    // Whether we started it or found it already up, the useful answer is the same, and it is the one the
    // operator would have got by typing `dahrk status` next. So just give it to them.
    await printStatus(env);
    return 0;
  }
  // Daemonising is impossible here (no supervisor, or no user session - a container). Running the worker
  // inline is the honest thing to do: the alternative is to "install" a service that can never start.
  uiOut("");
  uiOut(verdict("warn", `${outcome.reason}; running the node in this terminal instead.`));
  uiOut("");
  uiOut(hint("Use `dahrk start --foreground` (or DAHRK_FOREGROUND=1) to ask for this explicitly."));
  return startForeground(env, flags);
}

/** The connection / identity inputs the service commands bake into the unit, resolved once from the env
 *  (which the caller has already overlaid the flags onto). The token is NOT baked in - see `service.ts` -
 *  but it is still resolved here, because "is there a token at all?" is the one thing `install` refuses
 *  to proceed without. */
const serviceInputs = (env: NodeJS.ProcessEnv): { token?: string; name?: string; hubUrl?: string } => ({
  ...(resolveEnrolToken(env) ? { token: resolveEnrolToken(env) as string } : {}),
  ...(env.DAHRK_NODE_NAME ? { name: env.DAHRK_NODE_NAME } : {}),
  ...(env.DAHRK_HUB_URL ? { hubUrl: env.DAHRK_HUB_URL } : {}),
});

/**
 * Put the token the operator just gave us on disk, where the daemon will look for it.
 *
 * The daemon no longer inherits a token from its unit, so `dahrk start --token <t>` has to write it down
 * itself - it cannot wait for `onEnrolled` to cache it after a successful `welcome` the way a foreground
 * node does, because the process that connects is a different one that has already read the file.
 *
 * We keep the old guarantee that a token the hub would reject never reaches the disk, by asking the hub
 * first (the same probe `dahrk doctor` runs). Only an outright REJECTION blocks the write: a hub we cannot
 * reach is not evidence about the token, and refusing to install a service because the network is down
 * would be its own kind of wrong. Nothing to do when the token is the one already on disk - that is the
 * ordinary `dahrk start` / reboot path, and it must not need the network at all.
 *
 * Returns a process exit code: 0 = the disk is good, 2 = the hub rejected the token.
 */
async function enrolToDisk(env: NodeJS.ProcessEnv): Promise<number> {
  const token = resolveEnrolToken(env);
  if (!token || token === readPersistedToken(env)) return 0;

  const hubUrl = env.DAHRK_HUB_URL ?? DEFAULT_HUB_URL;
  const probe = await probeHub({ hubUrl, enrolToken: token, clientVersion: CLIENT_VERSION });
  if (!probe.ok && probe.reason === "rejected") {
    uiOut("");
    uiOut(verdict("fail", `The hub rejected that enrolment token: ${probe.detail}`));
    uiOut("");
    uiOut(hint("Get a fresh token at https://app.dahrk.ai, then run `dahrk start --token <token>` again."));
    return 2;
  }
  if (!probe.ok) {
    uiOut("");
    uiOut(verdict("warn", `Could not reach ${hubUrl} to check the token (${probe.detail}); using it anyway.`));
  }
  persistEnrolment(env, {
    token,
    ...(probe.ok ? { name: probe.name, tenantId: probe.tenantId } : {}),
  });
  return 0;
}

/**
 * `dahrk restart`: stop the node and start it again, as one act.
 *
 * `desired` is written ONCE, at the end, and only on success. The old composition wrote "stopped" in the
 * middle (because it really did call `stop`), so a restart whose start half failed left the node down and
 * recorded as though the operator had wanted it down - which is exactly the state `status` is meant to raise
 * the alarm about, silently disarmed by the command that caused it.
 */
async function restart(flags: StartFlags, force: boolean): Promise<number> {
  const env = envWithFlags(process.env, flags);
  uiOut("");
  uiOut(hint("Restarting the node..."));

  const outcome = await runNodeRestart({ ...serviceInputs(env), force });
  if (outcome.kind === "error") return outcome.code;
  if (outcome.kind === "foreground") {
    uiOut(verdict("warn", `${outcome.reason}; there is no service to restart.`));
    uiOut("");
    uiOut(hint("A node running in a terminal is restarted by stopping it (Ctrl-C) and starting it again."));
    return 1;
  }
  setDesired(env, "running");
  await printStatus(env);
  return 0;
}

/**
 * Run the node in THIS process: resolve identity + runtimes, then dial the hub and serve Jobs (blocks
 * until exit). This is what the installed service invokes, and what a container / pm2 / CI should invoke.
 *
 * Enrolment is a one-time act: `--token` / `DAHRK_ENROL_TOKEN` wins, but absent both we present the
 * token cached by the last successful enrolment, so a bare start (or a reboot) re-attaches rather than
 * dying with "an enrolment token is required". We cache the token only once the hub has welcomed it, so a
 * typo is never written to disk.
 */
async function startForeground(env: NodeJS.ProcessEnv, flags: StartFlags): Promise<number> {
  // One node per host. The node's id is persisted and re-presented on every dial, so a second copy is not
  // a second node - it is this node, dialling twice and racing itself for Jobs. An ephemeral node mints a
  // throwaway id and so cannot collide with anything: it is the one case where a second process is sound.
  if (!flags.ephemeral) {
    const lock = acquireLock(defaultLockDeps(lockFile(env)));
    if (!lock.ok) {
      console.error(`A node is already running on this host (pid ${lock.heldBy}).`);
      console.error("Follow it with `dahrk logs -f`, or stop it with `dahrk stop` first.");
      // Non-zero: we were asked to run a node and did not. Exiting 0 here would tell a supervisor the
      // worker had finished cleanly, and it would cheerfully restart it into the same refusal.
      return 1;
    }
    process.on("exit", lock.release);
  }

  // Boot is the one moment nothing is mid-write, so it is when we bound the log files.
  const files = logFiles(env);
  rotateIfLarge(files.out);
  rotateIfLarge(files.err);

  const nodeId = resolveNodeId(env, { ephemeral: flags.ephemeral });

  // The node's own structured log. Everything below logs through this: stdout keeps the exact line-tagged
  // markers it always printed (so the supervisor's node.out.log is unchanged), and the same records land in
  // node.jsonl with levels, correlation ids and stacks - at `debug`, whatever stdout is set to, because you
  // never learn you wanted debug until after the incident.
  // The shipper is built BEFORE the logger, because it has to BE one of the logger's streams. It ships
  // nothing until the hub's `welcome` grants it permission - and never more than `DAHRK_TELEMETRY` allows,
  // which is the operator's ceiling and outranks anything the hub asks for.
  const shipper = new LogShipper({ ceiling: ceilingFromEnv(env) });

  const logger = createNodeLoggerFromEnv(env, logDir(env), { nodeId, clientVersion: CLIENT_VERSION }, shipperStream(shipper));

  // The net under every best-effort `.catch()` seam in the node. Before this, one stray rejection from any
  // background path killed the process and printed a single line with no stack.
  installProcessSafetyNet({
    logger,
    crashDir: crashDir(env),
    clientVersion: CLIENT_VERSION,
    ...(env.DAHRK_CRASH_EXIT === "1" ? { exitOnCrash: true } : {}),
  });
  // `supervised` makes the disk outrank the unit's env - see `resolveEnrolToken`. It is what stops a unit
  // written by an older client (which baked the token in) from shadowing a token the operator has since
  // re-enrolled with, on every boot, forever.
  const token = resolveEnrolToken(env, {
    ephemeral: flags.ephemeral,
    supervised: env.DAHRK_SUPERVISED === "1",
  });
  if (token) env.DAHRK_ENROL_TOKEN = token;
  const runtimes = await resolveRuntimes(env);
  // Compare against the set advertised on the previous boot (persisted in node.json). A runtime that
  // was there last run and is missing now is a degradation worth shouting about - the exact silent
  // failure DHK-390 was about - as distinct from one that was simply never installed. Skipped for an
  // ephemeral node (no disk), and harmless when nothing was persisted yet (an empty prior set).
  if (!flags.ephemeral) {
    const prior = readState(stateFile(env)).runtimes ?? [];
    const missing = prior.filter((r) => !runtimes.includes(r));
    if (missing.length > 0) {
      logger.warn(
        { prior, detected: runtimes, missing },
        `RUNTIMES_DEGRADED:${missing.join(",")} advertised last run but not detected now - the node will ` +
          "serve no Jobs for it until it is re-probed or restarted. Run `dahrk doctor` to check.",
      );
    }
    // Persist the set this boot detected so the next boot can run the same diff.
    writeState(env, { runtimes });
  }
  // The boot line the incident was missing: state plainly which runtimes were detected, so a degraded
  // advertisement is visible in the log instead of only inferable from stages failing at dispatch.
  logger.info({ runtimes }, `RUNTIMES_DETECTED:${runtimes.join(",") || "none"}`);
  if (runtimes.length === 0) {
    console.warn(
      "no agent runtimes detected on this host (claude/codex/pi not on PATH); the node will advertise " +
        "none and serve no Jobs. Install a runtime or set DAHRK_RUNTIMES to override. Run `dahrk doctor` to check.",
    );
  }
  if (!flags.ephemeral) setDesired(env, "running");
  // Nobody is watching a daemon's stdin, so it never prompts - it just says so in the log, once a day.
  scheduleUpdateChecks(env);

  const resolved: ResolvedBoot = { nodeId, runtimes, clientVersion: CLIENT_VERSION };
  const persist = token !== undefined && !flags.ephemeral;
  await startEdgeNode({
    ...buildEdgeOptions(env, resolved),
    logger,
    shipper,
    // Self-heal a transiently-degraded boot without a manual restart: the edge re-probes on this seam
    // and re-advertises when the set changes. Reuses `resolveRuntimes`, so `DAHRK_RUNTIMES` still wins
    // (a pinned override never re-probes to something else) and the mock runner path stays stable.
    reprobeRuntimes: () => resolveRuntimes(env),
    ...(env.DAHRK_RUNTIME_RECHECK_MS ? { runtimeRecheckMs: Number(env.DAHRK_RUNTIME_RECHECK_MS) } : {}),
    // What this node is running, on disk, so a crash mid-stage does not silently re-run the stage from
    // scratch (DHK-416). Skipped for an ephemeral node for the same reason it never caches a token: a
    // one-shot CI node touches no state dir, and has no next boot to recover into.
    ...(flags.ephemeral ? {} : { jobLedger: fileJobLedger(jobLedgerFile(stateDir(env))) }),
    ...(persist
      ? {
          onEnrolled: (welcome) =>
            persistEnrolment(env, { token, name: welcome.name, tenantId: welcome.tenantId }),
        }
      : {}),
    // How a rejected node heals. Reads `node.json` DIRECTLY rather than going through
    // `resolveEnrolToken`, and that is the whole point: the disk is where re-enrolment writes, so it is
    // the only place a *newer* token can appear. (Deliberately narrower than boot-time resolution, which
    // still lets an explicit `DAHRK_ENROL_TOKEN` win - but a stale env var must never be able to shadow
    // the fresh token on disk forever, which is precisely how a node used to wedge.)
    //
    // Only for a persistent node: an ephemeral one has no disk to heal from and must still fail fast.
    ...(flags.ephemeral ? {} : { refreshEnrolToken: () => readPersistedToken(env) }),
  });
  // startEdgeNode blocks for the life of the node; reaching here is a clean shutdown.
  return 0;
}

/** `dahrk stop`: stop the node, and remember that we meant it - so `status` reports a stopped node as
 *  stopped rather than as a crash-loop, and so its exit code stays a usable health check. */
async function stop(env: NodeJS.ProcessEnv, force: boolean): Promise<number> {
  const code = await runNodeStop({ force });
  // STOP_FOREIGN_NODE is a non-zero exit, but the service IS stopped and the operator DID mean it - the
  // node still up is one another supervisor owns. Record the intent anyway, or `status` would read the
  // stopped service back as a crash-loop.
  if (code === 0 || code === STOP_FOREIGN_NODE) setDesired(env, "stopped");
  return code;
}

/** Point `dahrk update`'s cache write at the SAME state file everything else uses.
 *
 *  `update.ts` defaults to `process.env`, which is very nearly right - but `status` reads through the
 *  alias-applied env (`applyEnvAliases`), so a node still configured with the legacy `SKAKEL_STATE_DIR`
 *  would have `update` writing its answer to one file and `status` reading from another, and the cache would
 *  appear never to update at all. Resolve it once, here, where the aliases have already been folded in. */
const updateStateDeps = (env: NodeJS.ProcessEnv): Partial<UpdateDeps> => ({
  saveResult: (patch) => writeState(env, patch),
});

/** The IO the update check runs on: the clock, the registry, and the state file it caches into. */
function updateCheckDeps(env: NodeJS.ProcessEnv): UpdateCheckDeps {
  return {
    env,
    now: () => Date.now(),
    binPath: process.argv[1],
    readState: () => readState(stateFile(env)),
    saveResult: (patch) => writeState(env, patch),
    fetchLatest: fetchLatestVersion,
  };
}

/** The interactive half of the update check: tell the operator they are behind, and offer to fix it while
 *  they are here. A failed upgrade is reported but never fatal - being on an old client is not a reason to
 *  refuse to start the node. */
async function offerUpdate(env: NodeJS.ProcessEnv): Promise<void> {
  const available = await checkForUpdate(CLIENT_VERSION, updateCheckDeps(env));
  if (!available) return;
  uiOut("");
  uiOut(renderUpdateNotice(available));
  if (!isInteractive()) return;
  if (!(await confirm("Update now?"))) return;
  const code = await runUpdate({ currentVersion: CLIENT_VERSION, check: false }, updateStateDeps(env));
  if (code !== 0) uiOut(hint("Update failed; starting the node on the current version anyway."));
}

/** The daemon half: no prompt, no self-update, just a line in the log so that whoever eventually reads it
 *  (or greps a fleet's logs) can see the node is behind. Jittered, so a thousand nodes booted from one
 *  image do not all ask npm the same question in the same second. */
function scheduleUpdateChecks(env: NodeJS.ProcessEnv): void {
  if (checkSuppressed(env)) return;
  const deps = updateCheckDeps(env);
  const tick = async (): Promise<void> => {
    const available = await checkForUpdate(CLIENT_VERSION, deps);
    if (available) process.stdout.write(`${renderUpdateLogLine(available)}\n`);
  };
  // unref'd throughout: an update check must never be the reason a node refuses to exit.
  setTimeout(() => void tick(), jitterMs(Math.random())).unref();
  setInterval(() => void tick(), checkIntervalMs(env)).unref();
}

/** The real IO `dahrk status` runs on: the host, the state file, the supervisor probe, the pidfile, the job
 *  ledger and the log tail. Kept here (not in status.ts) so that module stays free of node:child_process and
 *  node:fs, and unit-tests with plain fakes.
 *
 *  Every source here is a LOCAL read. That is the contract `status` is built on, and there is a test that
 *  fails the moment anything in this object reaches for the network. */
function statusDeps(env: NodeJS.ProcessEnv): StatusDeps {
  return {
    platform: osPlatform(),
    homeDir: homedir(),
    env,
    binPath: process.argv[1],
    // The rich probe, with versions - the same one `doctor` runs. An explicit DAHRK_RUNTIMES override still
    // wins, and is reported as installed-without-a-version, because a pinned runtime was never probed.
    probeRuntimes: async () => {
      const override = list(env.DAHRK_RUNTIMES).filter(isRuntime);
      if (override.length > 0) {
        return RUNTIMES.map((r) => ({ runtime: r, cmd: r, installed: override.includes(r) }));
      }
      return probeRuntimeStatuses();
    },
    fileExists: (path) => existsSync(path),
    capture: (argv) => {
      const [cmd, ...args] = argv;
      try {
        // The probe's output is PARSED, not shown, so capture it rather than inheriting stdio.
        // stderr is ignored: `launchctl list` on an unknown label writes there and we read the exit code.
        const stdout = execFileSync(cmd as string, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return { code: 0, stdout };
      } catch (e) {
        const status = (e as { status?: unknown }).status;
        return { code: typeof status === "number" ? status : 1, stdout: "" };
      }
    },
    lockedPid: () => {
      const held = parseLock(readFileOrUndefined(lockFile(env)));
      return held !== undefined && isAlive(held) ? held : undefined;
    },
    // Best-effort by construction: a missing or unreadable ledger reads as "no jobs in flight", which shows
    // an idle node rather than failing the whole report over a file that only exists while work is running.
    jobs: () => fileJobLedger(jobLedgerFile(stateDir(env)), () => {}).all(),
    connection: () => {
      const raw = readFileOrUndefined(jsonlLogFile(env));
      return raw ? lastConnection(parseRecords(raw)) : undefined;
    },
    now: () => Date.now(),
    out: uiOut,
  };
}

/** Read a file, or undefined if it is not there / not readable. The node's log and pidfile are both
 *  optional: a node that has never run has neither, and that is a state to report, not an error. */
function readFileOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Print the canonical status block. What `start`, `stop` and `restart` all end with, so that "what
 *  happened" and "what is true now" are the same block of text rather than three summaries that drift. */
async function printStatus(env: NodeJS.ProcessEnv): Promise<number> {
  return runStatus(
    { clientVersion: CLIENT_VERSION, hubUrl: env.DAHRK_HUB_URL ?? DEFAULT_HUB_URL },
    statusDeps(env),
  );
}

/** The workflows `dahrk run` can dispatch. The seam is deliberately small: `preflight` is the first
 *  (and, for now, only) target. An unknown workflow is a usage error listing what is available. */
export const KNOWN_WORKFLOWS = ["preflight"] as const;

/** Run a workflow locally through the engine against the node's worktree (issue-less: no Linear, no
 *  OAuth). Resolves the workflow name, runs it, and returns the process exit code (non-zero on an
 *  unsound floor / failure). An unknown workflow returns exit 2 and lists the available ones. */
async function runWorkflow(flags: RunFlags): Promise<number> {
  if (flags.workflow !== "preflight") {
    console.error(`unknown workflow: ${flags.workflow}\n`);
    console.error(`Available workflows: ${KNOWN_WORKFLOWS.join(", ")}`);
    return 2;
  }
  const env = applyEnvAliases(process.env);
  // Defaulted, for the same reason `doctor` is: an unset DAHRK_HUB_URL is the NORMAL case, not a misconfig.
  const hubUrl = flags.hubUrl ?? env.DAHRK_HUB_URL ?? DEFAULT_HUB_URL;
  const token = flags.token ?? resolveEnrolToken(env);
  return runPreflight({
    ...(flags.repo ? { repoPath: flags.repo } : {}),
    ...(hubUrl ? { hubUrl } : {}),
    ...(token ? { token } : {}),
    clientVersion: CLIENT_VERSION,
  });
}

/**
 * `dahrk repo add`: register the current git repository with the hub. Everything is derived from the cwd
 * (the node already sits next to the code): the git URL from `origin` - in the form the host can actually
 * authenticate (SSH kept when there is a key, else normalised to HTTPS with a warning) - the default branch
 * from HEAD, a display name from the slug, and a deterministic id so re-runs dedupe rather than duplicate.
 *
 * It authenticates with the node's existing enrolment token and dials the hub's HTTP config surface
 * itself, so the daemon need not be running. Fails actionably outside a repo, with no `origin`, or when the
 * node is not yet enrolled; is an idempotent no-op on a repo that is already registered.
 */
async function runRepoAdd(flags: RepoAddFlags): Promise<number> {
  const env = applyEnvAliases(process.env);
  if (flags.hubUrl) env.DAHRK_HUB_URL = flags.hubUrl;
  if (flags.token) env.DAHRK_ENROL_TOKEN = flags.token;

  const cwd = process.cwd();
  const probe = probeRepo(cwd);
  if (!probe.isGitRepo) {
    uiOut("");
    uiOut(verdict("fail", `${cwd} is not a git repository.`));
    uiOut(hint("Run `dahrk repo add` from inside the repository you want to register."));
    return 1;
  }
  if (!probe.remoteUrl) {
    uiOut("");
    uiOut(verdict("fail", "This repository has no `origin` remote, so there is nothing to register."));
    uiOut(hint("Add one with `git remote add origin <url>`, then run `dahrk repo add` again."));
    return 1;
  }
  const token = resolveEnrolToken(env);
  if (!token) {
    uiOut("");
    uiOut(verdict("fail", "This node is not enrolled, so it cannot register a repository."));
    uiOut(hint("Enrol it first with `dahrk start --token <token>`."));
    return 1;
  }

  // Choose the URL form the host can authenticate, warning when an SSH remote had to become HTTPS.
  const { gitUrl, converted } = chooseGitUrl({ originUrl: probe.remoteUrl, sshKeyPresent: sshKeyPresent() });
  if (converted) {
    uiOut("");
    uiOut(verdict("warn", `No SSH key found on this host, so the SSH remote was registered as HTTPS: ${gitUrl}`));
    uiOut(hint("Add an SSH key (or set up brokered credentials) if this repo must be cloned over SSH - see DHK-252."));
  }
  const parsed = parseGitRemote(gitUrl);
  const name = flags.name ?? (parsed ? deriveRepoName(parsed) : "repo");
  const repo: RepoFacts = {
    id: deriveRepoId(gitUrl),
    name,
    gitUrl,
    // HEAD's branch is the run's base. An empty repo (no commits) has none yet; default to `main`.
    defaultBranch: probe.baseBranch ?? "main",
  };

  const base = hubHttpBase(env.DAHRK_HUB_URL ?? DEFAULT_HUB_URL);
  const result = await registerRepo({ fetch }, { base, token, repo });

  uiOut("");
  switch (result.kind) {
    case "registered":
      uiOut(verdict("ok", `Registered ${name} with the hub.`));
      uiOut(kv("URL", gitUrl));
      uiOut(kv("Branch", repo.defaultBranch));
      return 0;
    case "already":
      uiOut(verdict("ok", `${name} is already registered - nothing to do.`));
      if (result.drift) {
        const bits: string[] = [];
        if (result.drift.branch) bits.push(`branch ${result.drift.branch} (this repo is on ${repo.defaultBranch})`);
        if (result.drift.name) bits.push(`name ${result.drift.name}`);
        uiOut(hint(`The hub's stored record differs - ${bits.join(", ")} - and was left unchanged.`));
      }
      return 0;
    case "error":
      uiOut(verdict("fail", `Could not register the repository: ${result.message}`));
      return 1;
  }
}

/** Dispatch the CLI: `start` (default), `run`, `doctor`, `help`, `version`. Returns nothing for `start`
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
        // The same default the node itself dials. Without this, `dahrk doctor` on a stock install FAILED
        // with "no hub URL configured" while the node was connected to that very hub - it was reporting
        // that an env var was unset, not that anything was wrong.
        hubUrl: env.DAHRK_HUB_URL ?? DEFAULT_HUB_URL,
        // Same resolution as `start`, so doctor checks the token the node would actually present:
        // the flag/env if given, else the one cached by the last successful enrolment.
        token: resolveEnrolToken(env),
        clientVersion: CLIENT_VERSION,
      });
      break;
    }
    case "status": {
      // Local only: no dial, no token needed. `hubUrl` is reported (what we WOULD dial), not probed.
      const env = envWithFlags(process.env, parsed.flags);
      process.exitCode = await runStatus(
        {
          clientVersion: CLIENT_VERSION,
          hubUrl: env.DAHRK_HUB_URL ?? DEFAULT_HUB_URL,
          json: parsed.flags.json,
        },
        statusDeps(env),
      );
      break;
    }
    case "run":
      process.exitCode = await runWorkflow(parsed.flags);
      break;
    case "repo":
      process.exitCode = await runRepoAdd(parsed.flags);
      break;
    case "service": {
      if (parsed.flags.action === "uninstall") {
        process.exitCode = await runServiceUninstall();
        break;
      }
      // Install bakes the resolved connection/identity into the unit: flags win over the env vars
      // (legacy SKAKEL_* aliases folded in first).
      const env = applyEnvAliases(process.env);
      // Falls back to the cached token, so `dahrk start --token X` followed by `dahrk service install`
      // does not make the operator paste the token a second time.
      const token = parsed.flags.token ?? resolveEnrolToken(env);
      const name = parsed.flags.name ?? env.DAHRK_NODE_NAME;
      const hubUrl = parsed.flags.hubUrl ?? env.DAHRK_HUB_URL;
      process.exitCode = await runServiceInstall({
        ...(token ? { token } : {}),
        ...(name ? { name } : {}),
        ...(hubUrl ? { hubUrl } : {}),
      });
      break;
    }
    case "update":
      // Self-update is issue-less and hub-less: no flag overlay, just current vs latest. The env is still
      // resolved, because whatever it learns is written into the state file `status` reads.
      process.exitCode = await runUpdate(
        {
          currentVersion: CLIENT_VERSION,
          check: parsed.flags.check,
          verbose: parsed.flags.verbose,
        },
        updateStateDeps(applyEnvAliases(process.env)),
      );
      break;
    case "start":
      process.exitCode = await start(parsed.flags);
      break;
    case "stop":
      process.exitCode = await stop(applyEnvAliases(process.env), parsed.force);
      break;
    case "restart":
      // One act, not `stop` followed by `start`: see `restart` above for why that composition was wrong in
      // both what it printed and what it left behind in `desired`.
      process.exitCode = await restart(parsed.flags, parsed.force);
      break;
    case "logs": {
      const env = applyEnvAliases(process.env);
      process.exitCode = await runLogs(parsed.flags, defaultLogsDeps(logFiles(env), jsonlLogFile(env)));
      break;
    }
    case "diagnose": {
      const env = applyEnvAliases(process.env);
      // Run the doctor into a buffer rather than the terminal: its verdict belongs IN the bundle, so the
      // bundle answers "was the host even sane?" without us having to ask for a second paste.
      const doctorLines: string[] = [];
      const doctor = async (): Promise<string[]> => {
        await runDoctor(
          {
            ...(resolveEnrolToken(env) ? { token: resolveEnrolToken(env) as string } : {}),
            hubUrl: env.DAHRK_HUB_URL ?? DEFAULT_HUB_URL,
          },
          // Stripped: stdout is a TTY here (the operator is watching), so the doctor correctly colours its
          // report - but this copy is going into a JSON file that someone will open in an editor and paste
          // into an issue, and escape codes have no business being in it.
          { out: (line: string) => void doctorLines.push(stripAnsi(line)) },
        );
        return doctorLines;
      };
      process.exitCode = await runDiagnose(
        defaultDiagnoseDeps(
          {
            stateFile: stateFile(env),
            jsonlFile: jsonlLogFile(env),
            crashDir: crashDir(env),
            outFile: parsed.flags.out ?? defaultBundlePath(process.cwd(), new Date()),
          },
          CLIENT_VERSION,
          doctor,
        ),
      );
      break;
    }
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
    const enrolmentRejected = process.exitCode === ENROLMENT_REJECTED_EXIT_CODE;
    console.error(err instanceof Error ? err.message : String(err));

    // For a config error the message IS the answer and a stack is just noise. For anything else the
    // stack is the whole point - and this handler used to throw it away, which is why a node that died
    // on boot left nothing to read. Persist it either way: `dahrk diagnose` collects crash records, and
    // a node that will not start is exactly when you need one.
    if (!enrolmentRejected) {
      if (err instanceof Error && err.stack) console.error(err.stack);
      const env = applyEnvAliases(process.env);
      writeCrashRecord(crashDir(env), {
        at: new Date().toISOString(),
        kind: "uncaughtException",
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
        clientVersion: CLIENT_VERSION,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptimeSec: Math.round(process.uptime()),
      });
    }
    process.exit(process.exitCode || 1);
  });
}
