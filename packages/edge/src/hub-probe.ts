/**
 * A one-shot hub reachability + enrolment probe for `dahrk doctor`. It performs the same two-way
 * handshake the real client does - dial the hub, send `hello`, wait for `welcome` - but instead of
 * staying connected it resolves a single verdict and closes:
 *
 *   - `ok`          the hub replied `welcome`: reachable AND the token is valid (tenant bound).
 *   - `unreachable` the socket never opened (DNS/refused/TLS), so we cannot even ask.
 *   - `timeout`     it opened but no `welcome` arrived in time (hub hung / wrong endpoint).
 *   - `rejected`    the hub closed with an `EDGE_CLOSE` enrolment code: the token is the problem
 *                   (missing / invalid / pool-unknown / hub-unconfigured). `code` says which.
 *   - `closed`      it opened but the hub closed for some other reason before welcoming us.
 *
 * This lets the doctor report hub-reachability and token-validity as separate lines from one probe,
 * without ever starting a stage runner or registering the node for work.
 */
import { arch as osArch, platform as osPlatform } from "node:os";
import { WebSocket } from "ws";
import type { HubToEdge, Runtime } from "@dahrk/contracts";
import { decode, encode, isEnrolmentRejection } from "@dahrk/contracts";

export interface HubProbeOptions {
  hubUrl: string;
  /** Enrolment token to validate. Absent/empty probes reachability only (the hub answers
   *  ENROL_REQUIRED, which the doctor reports as a missing-token failure). */
  enrolToken?: string;
  /** Runtimes to advertise in the probe `hello` (cosmetic; the hub does not gate welcome on them). */
  runtimes?: Runtime[];
  /** Node id to present; defaults to a fixed `dahrk-doctor` so repeated probes reuse one record. */
  nodeId?: string;
  clientVersion?: string;
  /** How long to wait for `welcome` after the socket opens (default 8000ms). */
  timeoutMs?: number;
}

export type HubProbeResult =
  | { ok: true; nodeId: string; name: string; tenantId: string; credentialMode: string }
  | { ok: false; reason: "unreachable"; detail: string }
  | { ok: false; reason: "timeout"; detail: string }
  | { ok: false; reason: "rejected"; code: number; detail: string }
  | { ok: false; reason: "closed"; code: number; detail: string };

/** Human-readable meaning of each enrolment close code, used when the hub sends no close reason. */
function enrolmentDetail(code: number): string {
  switch (code) {
    case 4400:
      return "no enrolment token was presented";
    case 4401:
      return "the enrolment token is invalid, expired, or revoked";
    case 4404:
      return "the token verified but its pool no longer exists";
    case 4503:
      return "the hub has no enrolment secret configured";
    default:
      return `enrolment rejected (${code})`;
  }
}

/** Dial the hub, do the `hello`/`welcome` handshake, and resolve a single verdict. Never rejects. */
export function probeHub(opts: HubProbeOptions): Promise<HubProbeResult> {
  const {
    hubUrl,
    enrolToken,
    runtimes = [],
    nodeId = "dahrk-doctor",
    clientVersion = "0.0.0",
    timeoutMs = 8000,
  } = opts;

  return new Promise((resolve) => {
    let settled = false;
    let opened = false;
    let ws: WebSocket;

    const done = (result: HubProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Tear the socket down hard - the doctor is done with it and must not linger the process.
      // Keep the listeners attached: terminating a still-CONNECTING socket emits an async `error`,
      // and stripping the handler first would turn that into an unhandled-error crash. The handlers
      // are all guarded by `settled`, so they are no-ops now.
      try {
        ws.terminate();
      } catch {
        // already closed
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => done({ ok: false, reason: "timeout", detail: `no welcome within ${timeoutMs}ms` }),
      timeoutMs,
    );
    timer.unref?.();

    try {
      ws = new WebSocket(hubUrl);
    } catch (e) {
      // A malformed URL throws synchronously from the constructor.
      done({ ok: false, reason: "unreachable", detail: (e as Error).message });
      return;
    }

    ws.on("open", () => {
      opened = true;
      ws.send(
        encode({
          type: "hello",
          enrolToken: enrolToken ?? "",
          detectedRuntimes: runtimes,
          servesRepoIds: [],
          nodeId,
          os: osPlatform(),
          arch: osArch(),
          clientVersion,
        }),
      );
    });

    ws.on("message", (raw) => {
      let msg: HubToEdge;
      try {
        msg = decode<HubToEdge>(raw.toString());
      } catch {
        return; // ignore anything that is not a frame we can parse
      }
      if (msg.type === "welcome") {
        done({
          ok: true,
          nodeId: msg.nodeId,
          name: msg.name,
          tenantId: msg.tenantId,
          credentialMode: msg.credentialMode,
        });
      }
    });

    // A pre-open error (ECONNREFUSED, bad TLS, DNS) means we never reached the hub. A post-open
    // error is followed by `close`, which carries the more useful code, so defer to it there.
    ws.on("error", (e) => {
      if (!opened) done({ ok: false, reason: "unreachable", detail: (e as Error).message });
    });

    ws.on("close", (code: number, reason: Buffer) => {
      const detail = reason?.toString() || "";
      if (isEnrolmentRejection(code)) {
        done({ ok: false, reason: "rejected", code, detail: detail || enrolmentDetail(code) });
      } else if (!opened) {
        done({ ok: false, reason: "unreachable", detail: detail || `could not connect (${code})` });
      } else {
        done({ ok: false, reason: "closed", code, detail: detail || `hub closed the socket (${code})` });
      }
    });
  });
}
