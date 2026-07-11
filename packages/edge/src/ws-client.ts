/**
 * The edge node's WebSocket client. It dials OUT to the hub (no inbound ports),
 * advertises its runtimes and repos on connect, heartbeats for liveness, and
 * reconnects on drop. Each `job` frame is run by the stage runner and answered with
 * a `result` keyed by `awakeableId`; progress streams up meanwhile. It holds no
 * durable state - a kill mid-stage loses nothing the bridge cannot re-dispatch.
 *
 * Line-tagged markers (EDGE_CONNECTED / JOB_STARTED:{stageId} / JOB_DONE:{stageId})
 * let the harness time a kill, mirroring the S1 edge.
 */
import { randomUUID } from "node:crypto";
import { arch as osArch, platform as osPlatform } from "node:os";
import { WebSocket } from "ws";
import type { CredentialMode, EdgeToHub, HubToEdge, NodeErrorClass, Runtime } from "@dahrk/contracts";
import { decode, encode, isEnrolmentRejection } from "@dahrk/contracts";
import { createGitService, makeRunner, type GitLogger } from "@dahrk/executor-worktree";
import { collectHealth, HealthCounters } from "./health.js";
import { ceilingFromEnv, LogShipper } from "./log-shipper.js";
import { createNodeLogger, levelFromEnv, type NodeLogger } from "./logger.js";
import { denyToolRule, type PolicyRule } from "./policy.js";
import {
  createStageRunner,
  type BlobPutRequestArgs,
  type RetentionPolicy,
  type StageRunnerDeps,
  type TraceSink,
} from "./stage-runner.js";

/** Process exit code for a fatal enrolment rejection (EX_CONFIG): the token/config is wrong,
 *  not a transient failure. Distinct so a supervisor stops the node (pm2 `stop_exit_codes: [78]`)
 *  instead of crash-looping; any other non-zero exit still means "restart me". */
export const ENROLMENT_REJECTED_EXIT_CODE = 78;

/**
 * Bucket a stage failure into a class for the health report.
 *
 * This is a lossy mapping ON PURPOSE. The health report is metadata that leaves machines we do not own,
 * so it may carry the fact that git operations are failing, but never the message that would name the
 * repository they are failing against. Reading the message here to produce a bucket is fine - the message
 * itself does not leave this function.
 */
function classifyError(e: unknown): NodeErrorClass {
  const msg = e instanceof Error ? e.message : String(e);
  if (/\bgit\b|worktree|clone|fetch|branch|checkout|remote/i.test(msg)) return "git";
  if (/policy|denied|not permitted|forbidden/i.test(msg)) return "policy";
  if (/hub|websocket|socket|awakeable/i.test(msg)) return "hub";
  if (/runtime|claude|codex|\bpi\b|model|sdk|api key/i.test(msg)) return "runtime";
  return "internal";
}

export interface EdgeOptions {
  hubUrl: string;
  /** Optional self-hosted allowlist of registry repoIds this edge will serve. Empty/absent
   *  = serve any repo, cloning on demand from the Job's gitUrl. Advertised to the hub for routing. */
  servesRepoIds?: string[];
  runtimes: Runtime[];
  /** Re-probe the host's installed runtimes after boot. A node that came up with a transiently
   *  degraded set (a probe that timed out during boot IO churn, DHK-390) self-heals: called on an
   *  interval, and when the detected set differs from what is currently advertised the node re-sends
   *  `hello` with the fresh set (the hub's `handleAdvertise` accepts re-advertisement). Omitted
   *  (tests / embedders) = the boot-time `runtimes` are advertised for the life of the process. */
  reprobeRuntimes?: () => Promise<Runtime[]>;
  /** How often to re-probe runtimes (ms) when `reprobeRuntimes` is set. Default 60000. */
  runtimeRecheckMs?: number;
  /** Where this node's git credentials come from; advertised to the hub. Default `ambient`. */
  credentialMode?: CredentialMode;
  /** True when the operator explicitly set the credential mode. Only then is it sent in the
   *  `hello` frame as an override; otherwise the hub derives it from the pool and pushes it in `welcome`. */
  credentialModeExplicit?: boolean;
  /** Stable node id a fleet node presents on connect, so the hub routes Jobs to it and keeps its
   *  crash-recovery flush node-scoped. Omitted = the hub registers it under the default node id. */
  nodeId?: string;
  /** Optional display-name override (`--name`). Absent = the hub assigns a friendly name. */
  name?: string;
  /** This edge's build version, sent in `hello` for observability. */
  clientVersion?: string;
  /** Pool-scoped enrolment token (minted by the portal). Presented on connect so the hub binds this
   *  node to its pool/tenant. Omitted for a legacy ambient edge. */
  enrolToken?: string;
  /** The tenant this node is bound to. Set by a managed node so the stage runner refuses a Job
   *  for another tenant as defence in depth. Omitted for a legacy ambient edge (no tenant guard). */
  tenantId?: string;
  /** Where worktrees are created (defaults to the GitService default). */
  worktreesDir?: string;
  /** Where per-repo bare mirrors are cached (defaults to the GitService default). */
  mirrorsDir?: string;
  /** Demo policy (M3): deny tool actions using this tool name. */
  denyTool?: string;
  heartbeatMs?: number;
  /** Worktree retention (omitted = keep all run worktrees on the edge). */
  retention?: RetentionPolicy;
  /** Called each time the hub WELCOMES this node, i.e. the enrolment token was accepted, with the
   *  identity the hub assigned. The CLI uses it to cache the token (so the next bare `dahrk start`
   *  re-attaches without `--token`) and the name/tenant (so `dahrk status` can name the node without
   *  dialling). Gating on the welcome, rather than on connect, is what keeps a token the hub would
   *  reject from ever reaching the disk. */
  onEnrolled?: (welcome: { name: string; tenantId: string; credentialMode: CredentialMode }) => void;
  /** Abort to stop the node: closes the socket and suppresses the reconnect. For embedders that own
   *  the process lifecycle (and for tests); `main.ts` lets process exit do it. */
  signal?: AbortSignal;
  /** The node's logger. `main.ts` passes one wired to `~/.dahrk/logs/node.jsonl`; omitted (tests,
   *  embedders) we log to stdout only, which keeps the line-tagged markers intact with no file I/O. */
  logger?: NodeLogger;
  /** The shipper that batches log records up to the hub when policy permits. `main.ts` builds it and
   *  attaches it as a third pino stream; omitted (tests, embedders) nothing is ever shipped. */
  shipper?: LogShipper;
}

export async function startEdgeNode(opts: EdgeOptions): Promise<void> {
  const log = opts.logger ?? createNodeLogger({ level: levelFromEnv(process.env) });
  const rules: PolicyRule[] = opts.denyTool ? [denyToolRule(opts.denyTool)] : [];

  // Running tallies for the self-report: uptime, reconnects, in-flight jobs, failure counts by class.
  const counters = new HealthCounters();
  const shipper = opts.shipper;
  // The operator's local ceiling. The hub can ask for LESS than this; it can never ask for more. A node
  // whose operator set DAHRK_TELEMETRY=off reports nothing at all, whatever the hub says.
  const telemetryCeiling = ceilingFromEnv(process.env);

  // The runtime set we currently advertise. Starts at the boot-time probe (`opts.runtimes`) but is
  // mutable: `reprobeRuntimes` can correct a transiently-degraded boot without a restart (DHK-390),
  // and every `hello` and heartbeat reads THIS rather than the frozen `opts.runtimes`.
  let currentRuntimes = opts.runtimes;
  const runtimesKey = (r: Runtime[]): string => [...r].sort().join(",");

  // Wire the git service's logger seam. It has always existed (`GitLogger`, with meaningful calls on
  // every clone, mirror refresh and worktree create) but no production call site ever passed one, so it
  // resolved to the no-op and every git operation on a real node was silent - which is exactly the
  // information you want when a run fails to check out. Git detail is mapped to `debug`: it belongs in
  // the forensic file always, but should not clutter stdout unless the operator asks for it.
  const gitLog = log.child({ component: "git" });
  const gitLogger: GitLogger = {
    info: (msg) => gitLog.debug(msg),
    warn: (msg) => gitLog.warn(msg),
  };

  // Late-bound: the git service needs to know which runs are live (so clearing a stale branch claim can
  // never stomp one), but the stage runner that tracks that is constructed below, with the git service
  // as a dependency. Before it exists no run can be mid-stage, so `false` is the correct default.
  let stageRunnerRef: { isBusy(runId: string): boolean } | undefined;
  const gitService = createGitService({
    worktreesDir: opts.worktreesDir,
    mirrorsDir: opts.mirrorsDir,
    isBusy: (runId) => stageRunnerRef?.isBusy(runId) ?? false,
    logger: gitLogger,
  });

  let ws: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPongAt = 0;
  let shuttingDown = false;
  /** How many times we have connected. A flapping node (DHK-109/DHK-216) is one whose count climbs
   *  while its uptime does not; without it, a reconnect storm leaves no trace. */
  let connectCount = 0;
  // Set once the startup promise is wired; called on a fatal hub rejection so a pre-connect failure
  // rejects `startEdgeNode` (main.ts then exits non-zero) and a post-connect one stops the poll.
  let onFatal: ((err: Error) => void) | undefined;

  const send = (msg: EdgeToHub): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
  };

  // Give the shipper its transport, and start its flush timer. `send` returns false when the socket is
  // down, which is the shipper's signal to KEEP the batch rather than lose it - bounded by its ring, so a
  // node offline for an hour does not consume memory reporting on the fact.
  shipper?.attach((records) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(encode({ type: "node-log", records }));
    return true;
  });
  shipper?.start();

  // Consecutive missed pongs before we call the socket dead. Three beats is 15s at the 5000ms
  // default: long enough to ride out a slow hub, far short of the hub's 2100s stage backstop.
  const MISSED_PONGS_BEFORE_DEAD = 3;

  // One timer drives both liveness directions. Our `heartbeat` frame is application-level and
  // one-way (the hub only stamps `lastHeartbeatAt`), so it can never tell us the path is gone: a
  // half-open TCP connection leaves `readyState` at OPEN forever and `send()` writes into the void.
  // That is how the 2026-07-09 incident stayed invisible - the node streamed trace events at a hub
  // whose `nodes` map no longer held it, so it never reconnected and never got its Job re-sent. The
  // protocol-level ping is answered automatically by the hub's `ws` server, so a missing pong is
  // proof the path is dead: terminate and let the `close` handler reconnect.
  const startHeartbeat = (sock: WebSocket, intervalMs: number): void => {
    if (heartbeat) clearInterval(heartbeat);
    lastPongAt = Date.now();
    heartbeat = setInterval(() => {
      const sincePongMs = Date.now() - lastPongAt;
      if (sincePongMs > MISSED_PONGS_BEFORE_DEAD * intervalMs) {
        log.warn({ sincePongMs, intervalMs }, `EDGE_STALE:${sincePongMs}ms without a pong, terminating socket`);
        sock.terminate(); // -> `close` -> the existing 500ms reconnect
        return;
      }
      // The self-report rides the frame that was already going. Health is metadata only - numbers, enums
      // and a version string - which is what makes it safe to send from a machine we do not own. Suppressed
      // entirely when the operator set DAHRK_TELEMETRY=off; an older hub simply ignores the extra field.
      const health = shipper?.current().health ?? telemetryCeiling.health;
      send(
        health
          ? {
              type: "heartbeat",
              health: collectHealth({
                counters,
                clientVersion: opts.clientVersion ?? "0.0.0",
                runtimes: currentRuntimes,
                worktreesDir: gitService.worktreesDir,
              }),
            }
          : { type: "heartbeat" },
      );
      if (sock.readyState === WebSocket.OPEN) sock.ping();
    }, intervalMs);
  };

  // the edge sends each result exactly once, but a hub restart loses the in-memory map that
  // routes it, so a one-shot result is dropped and the run hangs forever at `phase: dispatch`. We
  // retain the last result/push-result frame per finished job and re-send them on every (re)connect.
  // The bridge resolves the awakeable idempotently (a duplicate gets a 4xx no-op), so re-sending is
  // safe; this closes the hole from the edge side without any durable state. Bounded so a long-lived
  // edge cannot leak memory: oldest entries evict past `MAX_RESEND` (well above concurrent in-flight).
  const MAX_RESEND = 100;
  const lastResults = new Map<string, EdgeToHub>();
  const rememberResult = (jobId: string, frame: EdgeToHub): void => {
    lastResults.delete(jobId); // re-key to most-recent insertion order
    lastResults.set(jobId, frame);
    if (lastResults.size > MAX_RESEND) {
      const oldest = lastResults.keys().next().value;
      if (oldest !== undefined) lastResults.delete(oldest);
    }
  };

  // Pending presigned-URL requests, resolved when the hub replies with `blob-put-url`.
  const pendingBlob = new Map<string, (r: { key: string; url?: string }) => void>();
  let blobReqCounter = 0;

  const trace: TraceSink = {
    event: (frame) => send({ type: "trace-event", ...frame }),
    finalised: (frame) => send({ type: "trace-finalised", ...frame }),
    requestBlobUrl: (req: BlobPutRequestArgs) =>
      new Promise((resolve) => {
        const reqId = `${req.runId}:${req.stageId}:${req.attempt}:${blobReqCounter++}`;
        pendingBlob.set(reqId, resolve);
        send({ type: "blob-put-request", reqId, ...req });
        // Safety: if the socket drops before a reply, resolve with no url (skip upload).
        setTimeout(() => {
          if (pendingBlob.delete(reqId)) resolve({ key: "" });
        }, 30000).unref?.();
      }),
  };

  // Held by reference so the `welcome` handler can push the hub-assigned tenant and
  // retention onto it. The stage runner reads `deps.tenantId` / `deps.retention` at call time, and a
  // Job only arrives after the hub registers the node (post-welcome), so mutating these is safe.
  const stageDeps: StageRunnerDeps = {
    gitService,
    makeRunner,
    logger: log,
    ...(opts.servesRepoIds ? { servesRepoIds: opts.servesRepoIds } : {}),
    ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    rules,
    sendProgress: (progress) => send({ type: "progress", progress }),
    // DHK-344: relay a mid-interactive-stage AskUserQuestion to the hub as an `elicit` frame; the hub
    // raises the Linear elicitation and the human's pick returns on the existing `turn` frame.
    sendElicit: (frame) => send({ type: "elicit", ...frame }),
    trace,
    ...(opts.retention ? { retention: opts.retention } : {}),
  };
  const stageRunner = createStageRunner(stageDeps);
  stageRunnerRef = stageRunner; // closes the late binding above

  // Reclaim leaked worktrees at boot, BEFORE the first job arrives (DHK-371). This is the only pass that
  // can collect worktrees created by a previous process: the runner's in-memory maps start empty, so
  // without it every worktree from a prior lifetime is orphaned for ever, holding both disk and its
  // branch name (which then wedges the next run of that issue). Best-effort and non-blocking to the
  // connect: a tidy-up must never stop the node coming up.
  void stageRunner
    .reapWorktrees()
    .then((r) => {
      // `scanned - reaped` is what is still on disk: the gauge that would have made the DHK-371 worktree
      // leak visible from the hub instead of from a full disk.
      counters.worktreeCount = Math.max(r.scanned - r.reaped.length, 0);
      if (r.reaped.length) {
        log.info(
          { reaped: r.reaped, scanned: r.scanned, skipped: r.skipped },
          `EDGE_REAPED:${r.reaped.length} worktrees (scanned ${r.scanned}, skipped ${r.skipped})`,
        );
      }
      for (const e of r.errors) log.warn({ reapError: e }, `EDGE_REAP_ERROR:${e}`);
    })
    .catch((e: unknown) => log.warn({ err: e }, `EDGE_REAP_ERROR:${(e as Error).message}`));

  // A persisted UUID identifies the node; fall back to an ephemeral one if none was provided.
  const nodeId = opts.nodeId ?? randomUUID();

  // The advertise/`hello` frame: who we are, and the runtimes we can serve. Sent on every (re)connect
  // and again whenever a re-probe corrects the advertised set (DHK-390); the hub's `handleAdvertise`
  // treats a later `hello` as a re-advertisement. A no-op while the socket is down (`send` guards it).
  const sendHello = (): void => {
    send({
      type: "hello",
      enrolToken: opts.enrolToken ?? "",
      detectedRuntimes: currentRuntimes,
      servesRepoIds: opts.servesRepoIds ?? [],
      ...(opts.credentialModeExplicit && opts.credentialMode ? { credentialMode: opts.credentialMode } : {}),
      nodeId,
      ...(opts.name ? { name: opts.name } : {}),
      os: osPlatform(),
      arch: osArch(),
      clientVersion: opts.clientVersion ?? "0.0.0",
      // Advertise the resolved worktree base so the hub records each run's real worktree location in
      // the projection instead of an advisory placeholder. Single-sourced from the git service so it
      // always matches where worktrees actually land.
      worktreesDir: gitService.worktreesDir,
    });
  };

  // Self-heal a transiently-degraded boot: re-probe the host's runtimes on an interval and, when the
  // set changes, re-advertise. Before this, a probe that missed a runtime at boot (a cold Node CLI
  // timing out during the update-restart's IO churn) latched for the life of the process, so every
  // stage needing that runtime failed fast at dispatch until a human restarted the node (DHK-390).
  let reprobeTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.reprobeRuntimes) {
    const reprobe = opts.reprobeRuntimes;
    reprobeTimer = setInterval(() => {
      void reprobe()
        .then((detected) => {
          if (runtimesKey(detected) === runtimesKey(currentRuntimes)) return;
          const before = currentRuntimes;
          currentRuntimes = detected;
          log.warn(
            { before, after: detected },
            `EDGE_RUNTIMES_CHANGED:${before.join(",") || "none"} -> ${detected.join(",") || "none"}`,
          );
          sendHello(); // re-advertise the corrected set; a no-op if the socket is currently down
        })
        .catch((e: unknown) => log.warn({ err: e }, `EDGE_REPROBE_ERROR:${(e as Error).message}`));
    }, opts.runtimeRecheckMs ?? 60000);
    reprobeTimer.unref?.();
  }

  // In-flight job/push ids, so a re-dispatched frame for a job that is STILL running is dropped rather
  // than starting a second runner on the same run worktree. The hub re-dispatches the SAME
  // jobId/awakeableId on its dispatch deadline, on every re-arm tick, and on each reconnect (502/521
  // churn); all carry a stable jobId, so this guard de-dups them. on_fail retries use a fresh jobId
  // and are allowed. A frame for a FINISHED job is not in this set - it is answered from `lastResults`
  // instead, and only a job we have neither running nor a cached result for genuinely re-runs.
  const running = new Set<string>();

  const onMessage = async (raw: string): Promise<void> => {
    const msg = decode<HubToEdge>(raw);
    if (msg.type === "welcome") {
      // The hub accepted us and pushed our identity + policy. Apply what the operator did not
      // override locally: the tenant guard, worktree retention, and the heartbeat interval. The stage
      // runner reads deps.tenantId/deps.retention at call time, and Jobs only arrive after this point.
      stageDeps.tenantId = msg.tenantId;
      if (opts.retention === undefined && msg.retention) stageDeps.retention = msg.retention;
      if (opts.heartbeatMs === undefined && msg.heartbeatMs > 0 && ws) {
        startHeartbeat(ws, msg.heartbeatMs);
      }
      // Apply the hub's telemetry policy exactly where `retention` and `heartbeatMs` are already applied.
      // The shipper clamps it to the local ceiling, so an operator opt-out always survives contact with
      // the hub. An older hub sends no `telemetry` at all, which correctly leaves the node on its own
      // default (health on, logs off).
      if (msg.telemetry && shipper) shipper.setPolicy(msg.telemetry);
      log.info(
        {
          name: msg.name,
          tenantId: msg.tenantId,
          credentialMode: msg.credentialMode,
          heartbeatMs: msg.heartbeatMs,
          ...(shipper ? { telemetry: shipper.current() } : {}),
        },
        `EDGE_WELCOMED:${msg.name} tenant=${msg.tenantId} credentialMode=${msg.credentialMode}`,
      );
      // The token is now known-good: let the caller cache it. Never fatal - failing to persist only
      // means the next boot needs `--token` again, which must not take down a healthy node.
      try {
        opts.onEnrolled?.({
          name: msg.name,
          tenantId: msg.tenantId,
          credentialMode: msg.credentialMode,
        });
      } catch (e) {
        log.warn({ err: e }, `EDGE_ENROL_PERSIST_FAILED ${(e as Error).message}`);
      }
      return;
    }
    if (msg.type === "blob-put-url") {
      const resolve = pendingBlob.get(msg.reqId);
      if (resolve) {
        pendingBlob.delete(msg.reqId);
        resolve({ key: msg.key, ...(msg.url ? { url: msg.url } : {}) });
      }
      return;
    }
    if (msg.type === "policy") {
      // An operator turning this node's logs up (or down) WITHOUT restarting it - which matters because
      // the moment you want a node's debug logs is the moment it is misbehaving, and bouncing it destroys
      // the state you were trying to look at. Still clamped to the local ceiling by the shipper.
      shipper?.setPolicy(msg.telemetry);
      log.info({ telemetry: shipper?.current() ?? msg.telemetry }, `EDGE_POLICY:logs=${shipper?.current().logs ?? msg.telemetry.logs}`);
      return;
    }
    if (msg.type === "cancel") {
      log.info({ jobId: msg.jobId }, `JOB_CANCEL:${msg.jobId}`);
      stageRunner.cancel(msg.jobId);
      return;
    }
    if (msg.type === "turn") {
      // A relayed human turn for an in-flight interactive stage (M5b): text feeds the open
      // conversation; an `end` closes it (complete -> gate exit, cancel -> abort).
      if (msg.end === "cancel") stageRunner.cancel(msg.jobId);
      else if (msg.end === "complete") stageRunner.endTurns(msg.jobId);
      else if (msg.turn) stageRunner.enqueueTurn(msg.jobId, msg.turn);
      log.info({ jobId: msg.jobId, ...(msg.end ? { end: msg.end } : {}) }, `JOB_TURN:${msg.jobId}${msg.end ? `:${msg.end}` : ""}`);
      return;
    }
    if (msg.type === "push") {
      // The `open-pr` action's git side: commit the worktree + push the run's branch, then resolve
      // the hub action handler's awakeable with the result. Mirrors the `job` path.
      const { job } = msg;
      // Bind the correlation ids once, so every line this push emits can be joined to the hub's run.
      const pushLog = log.child({ runId: job.runId, jobId: job.jobId, branch: job.branch });
      if (running.has(job.jobId)) {
        pushLog.warn({}, `PUSH_DUPLICATE:${job.runId} ${job.jobId}`);
        return;
      }
      const cachedPush = lastResults.get(job.jobId);
      if (cachedPush) {
        send(cachedPush);
        pushLog.info({}, `PUSH_REPLAY:${job.runId} ${job.jobId}`);
        return;
      }
      running.add(job.jobId);
      const pushStartedAt = Date.now();
      pushLog.info({}, `PUSH_STARTED:${job.runId} ${job.branch}`);
      try {
        const result = await stageRunner.runPush(job);
        const frame: EdgeToHub = { type: "push-result", awakeableId: job.awakeableId, result };
        rememberResult(job.jobId, frame);
        send(frame);
        // Log the git reason on failure (not just the status) so the edge transcript shows WHY the
        // push did not land - otherwise the cause is lost on a managed node.
        pushLog.info(
          { status: result.status, summary: result.summary, durationMs: Date.now() - pushStartedAt },
          `PUSH_DONE:${job.runId} ${result.status}${result.status !== "ok" ? ` - ${result.summary}` : ""}`,
        );
      } catch (e) {
        const frame: EdgeToHub = {
          type: "push-result",
          awakeableId: job.awakeableId,
          result: { jobId: job.jobId, status: "fail", summary: `edge push error: ${(e as Error).message}` },
        };
        rememberResult(job.jobId, frame);
        send(frame);
        // `err` carries the stack to the file sink; the marker line on stdout stays as it was.
        pushLog.error({ err: e, durationMs: Date.now() - pushStartedAt }, `PUSH_ERROR:${job.runId} ${(e as Error).message}`);
      } finally {
        running.delete(job.jobId);
      }
      return;
    }
    if (msg.type !== "job") return;
    const { job } = msg;
    // The same correlation ids the trace carries (`TraceMeta`), bound onto the log plane. This is what
    // lets `dahrk logs --run <id>` and the hub's `/api/runs/:runId` describe the same run.
    const jobLog = log.child({
      runId: job.runId,
      stageId: job.stageId,
      jobId: job.jobId,
      ...(job.tenantId ? { tenantId: job.tenantId } : {}),
      ...(job.agentConfig?.runtime ? { runtime: job.agentConfig.runtime } : {}),
      ...(job.agentConfig?.model ? { model: job.agentConfig.model } : {}),
    });
    if (running.has(job.jobId)) {
      // A re-dispatch of a still-running stage: drop it. The original runJob still owns the worktree
      // and will resolve the (shared) awakeable; a second runner here would corrupt the worktree.
      jobLog.warn({}, `JOB_DUPLICATE:${job.stageId} ${job.jobId}`);
      return;
    }
    const cachedJob = lastResults.get(job.jobId);
    if (cachedJob) {
      send(cachedJob);
      jobLog.info({}, `JOB_REPLAY:${job.stageId} ${job.jobId}`);
      return;
    }
    running.add(job.jobId);
    counters.activeJobs = running.size;
    const startedAt = Date.now();
    jobLog.info({}, `JOB_STARTED:${job.stageId} ${job.jobId}`);
    try {
      const result = await stageRunner.runJob(job);
      const frame: EdgeToHub = { type: "result", awakeableId: job.awakeableId, result };
      rememberResult(job.jobId, frame);
      send(frame);
      jobLog.info(
        { status: result.status, costUsd: result.costUsd, summary: result.summary, durationMs: Date.now() - startedAt },
        `JOB_DONE:${job.stageId} ${result.status}`,
      );
    } catch (e) {
      const frame: EdgeToHub = {
        type: "result",
        awakeableId: job.awakeableId,
        result: { jobId: job.jobId, status: "fail", summary: `edge error: ${(e as Error).message}` },
      };
      rememberResult(job.jobId, frame);
      send(frame);
      // The COUNT goes in the health report; the message does not. A count says this node is failing to
      // check out; the message would say which private repository it was failing to check out FROM.
      counters.recordError(classifyError(e));
      // `err` carries the stack into the file sink - the old code dropped it and kept only `.message`.
      jobLog.error({ err: e, durationMs: Date.now() - startedAt }, `JOB_ERROR:${job.stageId} ${(e as Error).message}`);
    } finally {
      running.delete(job.jobId);
      counters.activeJobs = running.size;
    }
  };

  const connect = (): void => {
    const sock = new WebSocket(opts.hubUrl);
    ws = sock;
    sock.on("open", () => {
      connectCount++;
      counters.connectCount = connectCount;
      log.info({ hubUrl: opts.hubUrl, nodeId, connectCount }, "EDGE_CONNECTED");
      // Two-way handshake: announce ourselves with the runtimes we detected, our persisted
      // id, and host info; the hub replies `welcome` with our tenant + policy (or closes the socket on a
      // bad token). `credentialMode` is sent only as an explicit operator override; otherwise the hub
      // derives it from the pool. `enrolToken` is required but tolerated-absent here so a
      // misconfigured node still surfaces the hub's ENROL_REQUIRED close rather than crashing locally.
      sendHello();
      // re-send the result of every finished-but-maybe-unacknowledged job. If the hub restarted
      // while a result was in flight (or just after), the new process forgot the awakeable mapping; the
      // bridge now resolves it idempotently, so this re-send is what un-wedges the run. A no-op when the
      // hub already has the result (4xx on the duplicate resolve).
      for (const frame of lastResults.values()) send(frame);
      startHeartbeat(sock, opts.heartbeatMs ?? 5000);
    });
    sock.on("message", (raw) => void onMessage(raw.toString()));
    sock.on("pong", () => {
      lastPongAt = Date.now();
    });
    sock.on("error", (e) => log.error({ err: e, hubUrl: opts.hubUrl }, `EDGE_ERROR ${(e as Error).message}`));
    sock.on("close", (code: number, reason: Buffer) => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      // A hub enrolment rejection is fatal: the token/config is wrong, not a transient drop.
      // Do NOT reconnect (that would loop silently). Exit with EX_CONFIG (78) - a DISTINCT
      // code so a supervisor (pm2 `stop_exit_codes`) can stop the node on a bad/missing token instead
      // of crash-looping, while still restarting on a transient (non-78) crash.
      if (isEnrolmentRejection(code)) {
        shuttingDown = true;
        const detail = reason.toString() || "enrolment rejected";
        log.error({ closeCode: code, detail, fatal: true }, `EDGE_REJECTED:${code} ${detail}`);
        process.exitCode = ENROLMENT_REJECTED_EXIT_CODE;
        onFatal?.(new Error(`hub rejected edge enrolment (${code}): ${detail}`));
        return;
      }
      if (!shuttingDown) {
        // Every reconnect is a datapoint: a node that flaps (DHK-109/DHK-216) shows up here as a
        // climbing `connectCount` against a steady uptime, which is otherwise invisible.
        log.warn({ closeCode: code, reason: reason.toString(), connectCount }, `EDGE_DISCONNECTED:${code} reconnecting in 500ms`);
        reconnectTimer = setTimeout(connect, 500); // reconnect with a small backoff
      }
    });
  };

  opts.signal?.addEventListener(
    "abort",
    () => {
      shuttingDown = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      if (reprobeTimer) clearInterval(reprobeTimer);
      reprobeTimer = undefined;
      ws?.close(1000, "shutting down");
    },
    { once: true },
  );

  connect();
  // Resolve once connected; the open socket + heartbeat keep the process alive. Reject instead if the
  // hub fatally rejects enrolment before we ever connect, so `main` exits non-zero.
  await new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(t);
        resolve();
      }
    }, 50);
    onFatal = (err: Error): void => {
      clearInterval(t);
      reject(err); // a no-op if we already resolved (post-connect rejection); exitCode is set regardless
    };
  });
}
