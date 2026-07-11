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
import type { CredentialMode, EdgeToHub, HubToEdge, Runtime } from "@dahrk/contracts";
import { decode, encode, isEnrolmentRejection } from "@dahrk/contracts";
import { createGitService, makeRunner } from "@dahrk/executor-worktree";
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

export interface EdgeOptions {
  hubUrl: string;
  /** Optional self-hosted allowlist of registry repoIds this edge will serve. Empty/absent
   *  = serve any repo, cloning on demand from the Job's gitUrl. Advertised to the hub for routing. */
  servesRepoIds?: string[];
  runtimes: Runtime[];
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
  /** Abort to stop the node: closes the socket and suppresses the reconnect. For embedders that own
   *  the process lifecycle (and for tests); `main.ts` lets process exit do it. */
  signal?: AbortSignal;
}

const log = (line: string): void => void process.stdout.write(`${line}\n`);

export async function startEdgeNode(opts: EdgeOptions): Promise<void> {
  const rules: PolicyRule[] = opts.denyTool ? [denyToolRule(opts.denyTool)] : [];
  const gitService = createGitService({
    worktreesDir: opts.worktreesDir,
    mirrorsDir: opts.mirrorsDir,
  });

  let ws: WebSocket | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPongAt = 0;
  let shuttingDown = false;
  // Set once the startup promise is wired; called on a fatal hub rejection so a pre-connect failure
  // rejects `startEdgeNode` (main.ts then exits non-zero) and a post-connect one stops the poll.
  let onFatal: ((err: Error) => void) | undefined;

  const send = (msg: EdgeToHub): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
  };

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
      if (Date.now() - lastPongAt > MISSED_PONGS_BEFORE_DEAD * intervalMs) {
        log(`EDGE_STALE:${Date.now() - lastPongAt}ms without a pong, terminating socket`);
        sock.terminate(); // -> `close` -> the existing 500ms reconnect
        return;
      }
      send({ type: "heartbeat" });
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
  // A persisted UUID identifies the node; fall back to an ephemeral one if none was provided.
  const nodeId = opts.nodeId ?? randomUUID();

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
      log(`EDGE_WELCOMED:${msg.name} tenant=${msg.tenantId} credentialMode=${msg.credentialMode}`);
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
    if (msg.type === "cancel") {
      log(`JOB_CANCEL:${msg.jobId}`);
      stageRunner.cancel(msg.jobId);
      return;
    }
    if (msg.type === "turn") {
      // A relayed human turn for an in-flight interactive stage (M5b): text feeds the open
      // conversation; an `end` closes it (complete -> gate exit, cancel -> abort).
      if (msg.end === "cancel") stageRunner.cancel(msg.jobId);
      else if (msg.end === "complete") stageRunner.endTurns(msg.jobId);
      else if (msg.turn) stageRunner.enqueueTurn(msg.jobId, msg.turn);
      log(`JOB_TURN:${msg.jobId}${msg.end ? `:${msg.end}` : ""}`);
      return;
    }
    if (msg.type === "push") {
      // The `open-pr` action's git side: commit the worktree + push the run's branch, then resolve
      // the hub action handler's awakeable with the result. Mirrors the `job` path.
      const { job } = msg;
      if (running.has(job.jobId)) {
        log(`PUSH_DUPLICATE:${job.runId} ${job.jobId}`);
        return;
      }
      const cachedPush = lastResults.get(job.jobId);
      if (cachedPush) {
        send(cachedPush);
        log(`PUSH_REPLAY:${job.runId} ${job.jobId}`);
        return;
      }
      running.add(job.jobId);
      log(`PUSH_STARTED:${job.runId} ${job.branch}`);
      try {
        const result = await stageRunner.runPush(job);
        const frame: EdgeToHub = { type: "push-result", awakeableId: job.awakeableId, result };
        rememberResult(job.jobId, frame);
        send(frame);
        // Log the git reason on failure (not just the status) so the edge transcript shows WHY the
        // push did not land - otherwise the cause is lost on a managed node.
        log(`PUSH_DONE:${job.runId} ${result.status}${result.status !== "ok" ? ` - ${result.summary}` : ""}`);
      } catch (e) {
        const frame: EdgeToHub = {
          type: "push-result",
          awakeableId: job.awakeableId,
          result: { jobId: job.jobId, status: "fail", summary: `edge push error: ${(e as Error).message}` },
        };
        rememberResult(job.jobId, frame);
        send(frame);
        log(`PUSH_ERROR:${job.runId} ${(e as Error).message}`);
      } finally {
        running.delete(job.jobId);
      }
      return;
    }
    if (msg.type !== "job") return;
    const { job } = msg;
    if (running.has(job.jobId)) {
      // A re-dispatch of a still-running stage: drop it. The original runJob still owns the worktree
      // and will resolve the (shared) awakeable; a second runner here would corrupt the worktree.
      log(`JOB_DUPLICATE:${job.stageId} ${job.jobId}`);
      return;
    }
    const cachedJob = lastResults.get(job.jobId);
    if (cachedJob) {
      send(cachedJob);
      log(`JOB_REPLAY:${job.stageId} ${job.jobId}`);
      return;
    }
    running.add(job.jobId);
    log(`JOB_STARTED:${job.stageId} ${job.jobId}`);
    try {
      const result = await stageRunner.runJob(job);
      const frame: EdgeToHub = { type: "result", awakeableId: job.awakeableId, result };
      rememberResult(job.jobId, frame);
      send(frame);
      log(`JOB_DONE:${job.stageId} ${result.status}`);
    } catch (e) {
      const frame: EdgeToHub = {
        type: "result",
        awakeableId: job.awakeableId,
        result: { jobId: job.jobId, status: "fail", summary: `edge error: ${(e as Error).message}` },
      };
      rememberResult(job.jobId, frame);
      send(frame);
      log(`JOB_ERROR:${job.stageId} ${(e as Error).message}`);
    } finally {
      running.delete(job.jobId);
    }
  };

  const connect = (): void => {
    const sock = new WebSocket(opts.hubUrl);
    ws = sock;
    sock.on("open", () => {
      log("EDGE_CONNECTED");
      // Two-way handshake: announce ourselves with the runtimes we detected, our persisted
      // id, and host info; the hub replies `welcome` with our tenant + policy (or closes the socket on a
      // bad token). `credentialMode` is sent only as an explicit operator override; otherwise the hub
      // derives it from the pool. `enrolToken` is required but tolerated-absent here so a
      // misconfigured node still surfaces the hub's ENROL_REQUIRED close rather than crashing locally.
      send({
        type: "hello",
        enrolToken: opts.enrolToken ?? "",
        detectedRuntimes: opts.runtimes,
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
    sock.on("error", (e) => log(`EDGE_ERROR ${(e as Error).message}`));
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
        log(`EDGE_REJECTED:${code} ${detail}`);
        process.exitCode = ENROLMENT_REJECTED_EXIT_CODE;
        onFatal?.(new Error(`hub rejected edge enrolment (${code}): ${detail}`));
        return;
      }
      if (!shuttingDown) reconnectTimer = setTimeout(connect, 500); // reconnect with a small backoff
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
