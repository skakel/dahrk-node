/**
 * @dahrk/edge - the edge node's brain (build spec sections 9, 11, 13).
 *
 *  - WebSocket client (`startEdgeNode`): dial OUT to the hub (no inbound ports),
 *    advertise runtimes/repos, heartbeat, reconnect.
 *  - Stage runner (`createStageRunner`): map one Job to one runner invocation in a
 *    real git worktree, stream progress, write the normalised trace, report a result
 *    keyed by jobId. Interactive stages and real inference arrive with M4.
 *  - Policy evaluation (`evaluatePolicies`): the governance hook points around tool
 *    actions and at stage entry; a deny surfaces as a tool error in the trace. The
 *    Phase 1 policy builtins are M6.
 *  - Stage-boundary hooks (R4): deterministic stage-exit checks run in the worktree.
 *
 * Built at M3 (mock Runner; +M4 real adapters, +M6 governance builtins).
 */
export { startEdgeNode, ENROLMENT_REJECTED_EXIT_CODE } from "./ws-client.js";
export type { EdgeOptions } from "./ws-client.js";
export { createStageRunner } from "./stage-runner.js";
export type {
  StageRunner,
  StageRunnerDeps,
  TraceSink,
  BlobPutRequestArgs,
  RetentionPolicy,
} from "./stage-runner.js";
export { evaluatePolicies, denyToolRule } from "./policy.js";
export type { PolicyEvent, PolicyRule } from "./policy.js";
export { detectRuntimes, probeRuntimeStatuses } from "./detect-runtimes.js";
export type { RuntimeStatus } from "./detect-runtimes.js";
export { probeHub } from "./hub-probe.js";
export type { HubProbeOptions, HubProbeResult } from "./hub-probe.js";
export { createNodeLogger, createNodeLoggerFromEnv, levelFromEnv, fileLevelFromEnv } from "./logger.js";
export type { LoggerOptions, LogLevel, NodeLogger } from "./logger.js";
export { scrubString, scrubValue, REDACTED } from "./redact.js";
export { collectHealth, diskFreeBytes, HealthCounters } from "./health.js";
export { ceilingFromEnv, LogShipper, shipperStream } from "./log-shipper.js";
export type { LogShipperOptions, ShipSend } from "./log-shipper.js";
