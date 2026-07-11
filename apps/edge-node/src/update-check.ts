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

/** Check at most once a day. Frequent enough that a node is never more than a day behind in what it knows,
 *  rare enough to be invisible. `DAHRK_UPDATE_CHECK_INTERVAL_MS` overrides (0 forces every start, which is
 *  how the tests and a curious operator get at it). */
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
    // Not time to ask - but we may already know, from the last time we did.
    return cachedUpdate(state, currentVersion, deps.binPath);
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

/** What the last check found, straight from the state file - no network. This is what `dahrk status` uses:
 *  its whole contract is that it is local, instant, and works offline, and an update notice is not worth
 *  breaking that for. */
export function cachedUpdate(
  state: NodeState,
  currentVersion: string,
  binPath: string | undefined,
): UpdateAvailable | undefined {
  const latest = state.updateLatest;
  if (!latest || !isNewer(latest, currentVersion)) return undefined;
  return { current: currentVersion, latest, channel: detectChannel(binPath) };
}
