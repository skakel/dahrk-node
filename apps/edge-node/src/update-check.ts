/**
 * The passive update check - "you are running an old client", said at the three moments you might hear it.
 *
 * `dahrk update` already exists, but it only helps someone who suspects they are behind. A node installed
 * as a service is started ONCE, ever, and then runs for months: it has no moment at which anyone would
 * think to ask. Always-on nodes rot quietly, and the more of them there are, the more quietly. So:
 *
 *   1. interactive `dahrk start` - notice, and offer to update there and then (a TTY, so we may ask);
 *   2. the running daemon - a `UPDATE_AVAILABLE:` line in the log, once a day (nobody to ask);
 *   3. `dahrk status` - from cache, so it stays offline.
 *
 * Nothing here ever updates by itself. A node that rewrites its own binary mid-Job, unattended, is a much
 * bigger promise than "tell me when I am stale", and it is not one this makes.
 *
 * Three properties matter more than the feature does, because an update check is exactly the sort of thing
 * that breaks the command it is bolted onto:
 *
 *  - It FAILS OPEN. Every failure - offline, DNS, a slow registry, a 500, a garbage body - is swallowed and
 *    means "no notice". A node must start on a plane, and npm having a bad day must never be able to stop
 *    one starting.
 *  - It is CACHED, not per-start. A crash-looping daemon restarts every ThrottleInterval; without the cache
 *    it would restart into a registry fetch every ten seconds, turning our outage into npm's.
 *  - It is BOUNDED. A short timeout, so the check can slow a start by at most that much.
 */
import type { NodeState } from "./state.js";
import { detectChannel, fetchLatestVersion, isNewer, upgradeCommand, type Channel } from "./update.js";

/** Check every six hours. Frequent enough that a running node's view of the registry is never more than a
 *  few hours old - which matters, because `dahrk status` reports what this check last learned, and a whole
 *  day of blind spot is a long time to be quietly telling someone they are current. Rare enough to remain
 *  invisible: one small GET per node per interval, jittered across a fleet. `DAHRK_UPDATE_CHECK_INTERVAL_MS`
 *  overrides (0 forces every start, which is how the tests and a curious operator get at it). */
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How far past the check interval the cached answer is treated as STALE rather than merely old.
 *
 *  Expressed as a multiple of the interval rather than as its own constant, so that overriding the interval
 *  moves both together: someone who checks hourly should hear about staleness sooner than someone who checks
 *  daily, and neither should have to discover a second knob to make that happen. Four intervals is the point
 *  at which "we have not managed to ask in a while" stops being noise and starts being the explanation for
 *  why the answer on screen looks wrong. */
export const STALE_AFTER_INTERVALS = 4;

/** The check may delay a start by at most this. Deliberately short: nobody agreed to wait on npm to start
 *  their node, and the cost of missing a check is that we mention the update tomorrow instead. */
export const FETCH_TIMEOUT_MS = 1_500;

/** Environments where a version notice is noise at best and a broken pipe at worst. `CI` is the de-facto
 *  standard variable every CI provider sets; `NO_UPDATE_NOTIFIER` is the one the npm ecosystem already
 *  respects, so someone who has opted out globally is opted out here too without having to learn a new
 *  name; `DAHRK_NO_UPDATE_CHECK` is ours, for turning it off on a single node. */
export function checkSuppressed(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DAHRK_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI);
}

/** The interval, honouring the override. A non-numeric value falls back to the default rather than
 *  becoming NaN - which would compare false against everything and check on literally every start. */
export function checkIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.DAHRK_UPDATE_CHECK_INTERVAL_MS;
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVAL_MS;
}

/** Is it time to ask the registry again? Pure: the caller supplies "now" and what the state file remembers.
 *  An unparseable or future-dated `checkedAt` (a clock that jumped, a hand-edited file) reads as "check
 *  now" - being a day early is harmless, whereas never checking again is the failure we are fixing. */
export function shouldCheck(
  now: number,
  checkedAt: string | undefined,
  intervalMs: number,
  env: NodeJS.ProcessEnv,
): boolean {
  if (checkSuppressed(env)) return false;
  if (!checkedAt) return true;
  const last = Date.parse(checkedAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= intervalMs || last > now;
}

/** Spread a fleet's daily checks over an hour instead of firing them all on the same tick. One node makes
 *  no difference; a thousand nodes that all booted from the same image do. */
export function jitterMs(random: number, spreadMs = 60 * 60 * 1000): number {
  return Math.floor(random * spreadMs);
}

/** What the check found, when it found something worth saying. */
export interface UpdateAvailable {
  current: string;
  latest: string;
  channel: Channel;
}

/** The human-facing notice, and the daemon's machine-readable one. The daemon's line follows the
 *  `TAG:value` shape the edge client already uses (`EDGE_CONNECTED`, `JOB_STARTED:`), so it reads as part
 *  of the same log rather than as an intruder in it. */
export function renderUpdateNotice(u: UpdateAvailable): string {
  const cmd = upgradeCommand(u.channel);
  const how = cmd ? ` (${u.channel}: ${cmd.display})` : " (run `dahrk update`)";
  return `update available: ${u.current} -> ${u.latest}${how}`;
}

export function renderUpdateLogLine(u: UpdateAvailable): string {
  return `UPDATE_AVAILABLE:${u.latest} current=${u.current}`;
}

/** Injectable IO: the fetch, the clock, the cache, and the randomness - so the whole thing tests without a
 *  network, a real state file, or a real clock. */
export interface UpdateCheckDeps {
  env: NodeJS.ProcessEnv;
  now: () => number;
  binPath: string | undefined;
  readState: () => NodeState;
  /** Persist what we learned, so the next start does not re-ask (and `status` can report it offline). */
  saveResult: (patch: { updateCheckedAt: string; updateLatest: string }) => void;
  fetchLatest: (signal?: AbortSignal) => Promise<string>;
}

/**
 * Ask whether a newer client exists, at most once per interval. Returns undefined when there is nothing to
 * say - which includes every failure. The caller cannot tell "you are current" from "the registry was
 * down", and that is deliberate: both mean "carry on and do not bother the operator".
 */
export async function checkForUpdate(
  currentVersion: string,
  deps: UpdateCheckDeps,
): Promise<UpdateAvailable | undefined> {
  // Opted out means opted out: not "do not fetch, but still nag from the cache". This has to be checked
  // here and not only inside `shouldCheck`, because the not-due path below deliberately falls back to what
  // we already know - and that fallback would otherwise resurrect the notice someone switched off.
  if (checkSuppressed(deps.env)) return undefined;

  const state = deps.readState();
  if (!shouldCheck(deps.now(), state.updateCheckedAt, checkIntervalMs(deps.env), deps.env)) {
    // Not time to ask - but we may already know, from the last time we did. This path only ever wants the
    // one state it can act on: `current` and `unknown` are both "say nothing and carry on", which is exactly
    // what `undefined` has always meant to these callers.
    const cached = cachedUpdate(state, currentVersion, deps.binPath);
    return cached.kind === "available" ? cached : undefined;
  }

  let latest: string;
  try {
    latest = await deps.fetchLatest(AbortSignal.timeout(FETCH_TIMEOUT_MS));
  } catch {
    // Fail open, always. Offline, slow, 500, garbage - none of it is the operator's problem right now.
    return undefined;
  }

  deps.saveResult({ updateCheckedAt: new Date(deps.now()).toISOString(), updateLatest: latest });
  if (!isNewer(latest, currentVersion)) return undefined;
  return { current: currentVersion, latest, channel: detectChannel(deps.binPath) };
}

/**
 * What we know about this client's currency, and - just as importantly - when we last knew it.
 *
 * The three states exist because the old shape had only two, and one of them was doing the work of two very
 * different facts. `cachedUpdate` used to return `UpdateAvailable | undefined`, reading only `updateLatest`
 * and ignoring `updateCheckedAt` entirely - so "we asked a minute ago and you are on the latest" and "we
 * have never once managed to ask" both came back as `undefined`, and `status` printed the same bare version
 * line for both. Silence was being asked to mean two opposite things, and the reader had no way to tell
 * which one they were getting.
 *
 * `unknown` is that missing third state. It is not a failure and it is not reassurance; it is the honest
 * answer when nothing has ever successfully asked the registry (a client installed but never started, a node
 * that has been down since before the first check, a machine that is always offline).
 *
 * `checkedAt` rides along on the other two because a claim of currency is only as good as its age. We cannot
 * promise you are on the latest - the registry may have moved a minute after we looked - but we can promise
 * what we last learned, and when. That is a claim we can actually stand behind.
 */
export type UpdateStatus =
  | ({ kind: "available"; checkedAt: number } & UpdateAvailable)
  | { kind: "current"; checkedAt: number }
  | { kind: "unknown" };

/** Is a cached answer old enough that presenting it as fact would be misleading? See
 *  {@link STALE_AFTER_INTERVALS}. */
export const isStale = (checkedAt: number, now: number, intervalMs: number): boolean =>
  now - checkedAt >= intervalMs * STALE_AFTER_INTERVALS;

/**
 * What the last check found, straight from the state file - no network. This is what `dahrk status` reads:
 * its whole contract is that it is local, instant, and works offline, and an update notice is not worth
 * breaking that for.
 *
 * A cache with no (or an unparseable) `updateCheckedAt` is `unknown` even when it happens to carry an
 * `updateLatest`: without a timestamp we cannot say how old that answer is, and an answer we cannot date is
 * one we have no business presenting as current.
 */
export function cachedUpdate(
  state: NodeState,
  currentVersion: string,
  binPath: string | undefined,
): UpdateStatus {
  const { updateLatest: latest, updateCheckedAt } = state;
  const checkedAt = updateCheckedAt ? Date.parse(updateCheckedAt) : NaN;
  if (!latest || !Number.isFinite(checkedAt)) return { kind: "unknown" };
  return isNewer(latest, currentVersion)
    ? { kind: "available", checkedAt, current: currentVersion, latest, channel: detectChannel(binPath) }
    : { kind: "current", checkedAt };
}
