/**
 * `dahrk doctor` - a preflight that tells the operator, in one pass, whether this host can run a node
 * and reach the hub before they commit to `dahrk start`. It checks four things:
 *
 *   1. Node version   - the runtime this client needs (Node 22+, per the README).
 *   2. Agent runtimes - which of claude / codex / pi are installed (a node with none serves no Jobs).
 *   3. Hub            - is the hub URL configured and does the WebSocket actually connect?
 *   4. Token          - is an enrolment token present, and does the hub accept it (valid vs
 *                       expired/invalid/pool-unknown)? Both are learned from one handshake probe.
 *
 * The check builders are pure (they take already-gathered inputs and return a verdict), so they are
 * unit-tested without a network or a specific host; `runDoctor` is the thin IO shell that gathers the
 * inputs, prints the report, and returns the process exit code (non-zero iff any check FAILED - a WARN
 * alone still passes).
 */
import type { HubProbeResult, RuntimeStatus } from "@dahrk/edge";
import { probeHub as realProbeHub, probeRuntimeStatuses } from "@dahrk/edge";
import { dim, out as uiOut, symbol, verdict, type Level } from "./ui.js";

/** The minimum Node major this client supports (README: "Requires Node 22+"). */
export const MIN_NODE_MAJOR = 22;

export type CheckStatus = "pass" | "warn" | "fail";
export interface CheckResult {
  status: CheckStatus;
  label: string;
  detail?: string;
}

/** The doctor's own vocabulary, mapped onto the one every command shares. It used to print `[PASS]` /
 *  `[WARN]` / `[FAIL]` tags that existed nowhere else in the tool; now a tick means the same thing here as
 *  it does in `status` and `run preflight`. */
const LEVEL: Record<CheckStatus, Level> = { pass: "ok", warn: "warn", fail: "fail" };

/** Check the running Node version against the supported floor. */
export function checkNode(nodeVersion: string): CheckResult {
  const major = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (Number.isNaN(major)) {
    return { status: "warn", label: "Node version", detail: `could not parse "${nodeVersion}"` };
  }
  return major >= MIN_NODE_MAJOR
    ? { status: "pass", label: "Node version", detail: `v${major} (>= ${MIN_NODE_MAJOR})` }
    : {
        status: "fail",
        label: "Node version",
        detail: `v${major} is too old; Dahrk needs Node ${MIN_NODE_MAJOR}+`,
      };
}

/** Check which agent runtimes are installed. None is a warning (the node boots but serves nothing). */
export function checkRuntimes(statuses: RuntimeStatus[]): CheckResult {
  const installed = statuses.filter((s) => s.installed);
  if (installed.length === 0) {
    return {
      status: "warn",
      label: "Agent runtimes",
      detail:
        "none detected (claude/codex/pi not on PATH); the node will serve no Jobs. Install one or set DAHRK_RUNTIMES.",
    };
  }
  const detail = installed.map((s) => `${s.runtime}${s.version ? ` (${s.version})` : ""}`).join(", ");
  return { status: "pass", label: "Agent runtimes", detail };
}

/** Hub reachability. An enrolment rejection still counts as REACHED (the token, not the hub, is the
 *  problem - reported separately by {@link checkToken}). */
export function checkHub(hubUrl: string | undefined, probe: HubProbeResult | undefined): CheckResult {
  if (!hubUrl) {
    return {
      status: "fail",
      label: "Hub reachability",
      detail: "no hub URL configured (set DAHRK_HUB_URL or pass --hub-url)",
    };
  }
  if (!probe) {
    return { status: "warn", label: "Hub reachability", detail: `not checked (${hubUrl})` };
  }
  if (probe.ok) {
    return { status: "pass", label: "Hub reachability", detail: `connected to ${hubUrl}` };
  }
  switch (probe.reason) {
    case "rejected":
      return {
        status: "pass",
        label: "Hub reachability",
        detail: `reachable at ${hubUrl} (enrolment rejected - see token check)`,
      };
    case "unreachable":
      return { status: "fail", label: "Hub reachability", detail: `cannot reach ${hubUrl}: ${probe.detail}` };
    case "timeout":
      return {
        status: "fail",
        label: "Hub reachability",
        detail: `${hubUrl} connected but sent no welcome: ${probe.detail}`,
      };
    case "closed":
      return {
        status: "fail",
        label: "Hub reachability",
        detail: `${hubUrl} closed the socket (${probe.code}): ${probe.detail}`,
      };
  }
}

/** Enrolment-token presence + validity. Presence is known locally; validity comes from the probe. */
export function checkToken(
  tokenPresent: boolean,
  hubUrl: string | undefined,
  probe: HubProbeResult | undefined,
): CheckResult {
  if (!tokenPresent) {
    return {
      status: "fail",
      label: "Enrolment token",
      detail: "no token (pass --token or set DAHRK_ENROL_TOKEN)",
    };
  }
  if (!hubUrl || !probe) {
    return { status: "warn", label: "Enrolment token", detail: "present but not verified (no hub to check against)" };
  }
  if (probe.ok) {
    return { status: "pass", label: "Enrolment token", detail: `valid (tenant ${probe.tenantId})` };
  }
  if (probe.reason === "rejected") {
    switch (probe.code) {
      case 4400:
        return { status: "fail", label: "Enrolment token", detail: `hub saw no token: ${probe.detail}` };
      case 4401:
        return { status: "fail", label: "Enrolment token", detail: "invalid, expired, or revoked" };
      case 4404:
        return { status: "fail", label: "Enrolment token", detail: "the token's pool no longer exists" };
      case 4503:
        return {
          status: "warn",
          label: "Enrolment token",
          detail: "cannot verify: the hub has no enrolment secret configured",
        };
      default:
        return { status: "fail", label: "Enrolment token", detail: probe.detail };
    }
  }
  // Hub unreachable/timeout/closed: we have a token but could not put it to the test.
  return { status: "warn", label: "Enrolment token", detail: "present but unverified (hub not reachable)" };
}

/** Render the gathered checks into the report body, ending with an overall pass/fail summary line.
 *
 *  The verdict comes LAST here, not first as it does in `status`, because a doctor's checks are the point:
 *  you run it to read them. `status` answers one question, so it leads with the answer; `doctor` answers
 *  four, so it shows its working and then adds them up. */
export function formatReport(checks: CheckResult[]): string {
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const lines = checks.map((c) => `  ${symbol(LEVEL[c.status])} ${c.label}${c.detail ? `: ${dim(c.detail)}` : ""}`);
  const summary =
    failed > 0
      ? verdict("fail", `${failed} check${failed === 1 ? "" : "s"} failed${warned ? `, ${warned} warning${warned === 1 ? "" : "s"}` : ""}.`)
      : warned > 0
        ? verdict("warn", `Passed with ${warned} warning${warned === 1 ? "" : "s"}.`)
        : verdict("ok", "All checks green.");
  return ["", ...lines, "", summary].join("\n");
}

/** Injectable IO/probes so `runDoctor` can be exercised without a network or a real host. */
export interface DoctorDeps {
  nodeVersion: string;
  probeRuntimes: (timeoutMs?: number) => Promise<RuntimeStatus[]>;
  probeHub: typeof realProbeHub;
  out: (line: string) => void;
}

const defaultDeps = (): DoctorDeps => ({
  nodeVersion: process.versions.node,
  probeRuntimes: probeRuntimeStatuses,
  probeHub: realProbeHub,
  out: uiOut,
});

export interface DoctorInputs {
  hubUrl?: string;
  token?: string;
  clientVersion?: string;
}

/**
 * Gather inputs, run the checks, print the report, and return the exit code (0 = no failures,
 * 1 = at least one FAIL). `inputs` are the already-resolved hub URL / token (flags overlaid on env).
 */
export async function runDoctor(inputs: DoctorInputs, deps: Partial<DoctorDeps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...deps };
  const statuses = await d.probeRuntimes();
  const installed = statuses.filter((s) => s.installed).map((s) => s.runtime);

  const probe = inputs.hubUrl
    ? await d.probeHub({
        hubUrl: inputs.hubUrl,
        ...(inputs.token ? { enrolToken: inputs.token } : {}),
        runtimes: installed,
        ...(inputs.clientVersion ? { clientVersion: inputs.clientVersion } : {}),
      })
    : undefined;

  const checks: CheckResult[] = [
    checkNode(d.nodeVersion),
    checkRuntimes(statuses),
    checkHub(inputs.hubUrl, probe),
    checkToken(Boolean(inputs.token), inputs.hubUrl, probe),
  ];

  d.out(formatReport(checks));
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
