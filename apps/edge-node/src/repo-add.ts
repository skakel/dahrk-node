/**
 * `dahrk repo add` - register the current git repository with the hub, deriving everything from the
 * cwd so the operator never pastes a git URL. The node already sits next to the code, so it can read
 * the `origin` remote and the current branch itself.
 *
 * This module is the pure, testable core: parse a git remote, choose the URL form the host can
 * actually authenticate (SSH vs HTTPS), derive a display name and a deterministic id, translate the
 * hub's WebSocket URL to its HTTP twin, and POST the registration. The IO shell (`runRepoAdd` in
 * `main.ts`) gathers the cwd facts and prints the outcome; everything here is a pure function or a
 * thin `fetch` wrapper with the network injected, so it unit-tests without a repo or a hub.
 */
import { createHash } from "node:crypto";

/** A git remote resolved to its parts: the host it lives on, the owner (org/user, possibly nested),
 *  and the bare repository name (no `.git`). */
export interface GitRemote {
  host: string;
  owner: string;
  repo: string;
}

/** Strip a trailing `.git` and any trailing slash from a remote's path portion. */
const stripRepoSuffix = (s: string): string => s.replace(/\.git$/i, "").replace(/\/+$/, "");

/** Split a `owner[/sub...]/repo` path into `{owner, repo}`, or undefined when it has no owner segment
 *  (a lone `repo` is not a remote we can register). */
function splitOwnerRepo(path: string): { owner: string; repo: string } | undefined {
  const parts = stripRepoSuffix(path).split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const repo = parts[parts.length - 1] as string;
  const owner = parts.slice(0, -1).join("/");
  return { owner, repo };
}

/**
 * Parse a git remote URL into host/owner/repo. Handles the two shapes a node actually meets:
 *  - URL form:  `https://host/org/repo(.git)`, `http://…`, `ssh://[user@]host[:port]/org/repo(.git)`
 *  - SCP form:  `git@host:org/repo(.git)` (the default GitHub/GitLab SSH remote)
 * Anything else (a local path, junk, an owner with no repo) returns undefined rather than throwing, so
 * the caller can degrade gracefully.
 */
export function parseGitRemote(url: string): GitRemote | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;

  // URL form: an explicit scheme, optional `user@`, host, optional `:port`, then the path.
  const urlMatch = /^(?:ssh|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  if (urlMatch) {
    const parts = splitOwnerRepo(urlMatch[2] as string);
    return parts ? { host: urlMatch[1] as string, ...parts } : undefined;
  }

  // SCP form: `[user@]host:path` with no scheme. The colon separates host from path (not a port here).
  const scpMatch = /^(?:[^@\s]+@)?([^/:\s]+):(.+)$/.exec(trimmed);
  if (scpMatch) {
    const parts = splitOwnerRepo(scpMatch[2] as string);
    return parts ? { host: scpMatch[1] as string, ...parts } : undefined;
  }

  return undefined;
}

/** The canonical HTTPS URL for a parsed remote: `https://host/owner/repo.git`. */
const httpsFormOf = (r: GitRemote): string => `https://${r.host}/${r.owner}/${r.repo}.git`;

/** True when a remote string is an HTTPS(S) URL rather than an SSH one. */
const isHttpsRemote = (url: string): boolean => /^https?:\/\//i.test(url.trim());

/**
 * Choose the git URL form to register, adapting to what the host can authenticate (the ticket's explicit
 * ask - do not blindly assume one protocol):
 *  - An HTTPS origin is registered as-is.
 *  - An SSH origin is kept when the host has an SSH key/agent identity to push with.
 *  - An SSH origin with no key is normalised to canonical HTTPS and flagged `converted`, so the caller
 *    can warn that it made the change. (Real private-clone credential setup stays with DHK-252; this
 *    only picks a sensible URL form.)
 * An unparseable origin is passed through unchanged rather than mangled.
 */
export function chooseGitUrl(input: { originUrl: string; sshKeyPresent: boolean }): { gitUrl: string; converted: boolean } {
  const originUrl = input.originUrl.trim();
  if (isHttpsRemote(originUrl)) return { gitUrl: originUrl, converted: false };
  if (input.sshKeyPresent) return { gitUrl: originUrl, converted: false };
  const parsed = parseGitRemote(originUrl);
  if (!parsed) return { gitUrl: originUrl, converted: false };
  return { gitUrl: httpsFormOf(parsed), converted: true };
}

/** The display name for a repo: its bare slug (e.g. `org/repo.git` -> `repo`). `--name` overrides this. */
export const deriveRepoName = (remote: GitRemote): string => remote.repo;

/**
 * A deterministic id for a repo, derived from its normalised identity (host/owner/repo, lower-cased) so
 * that re-running `repo add` - or running it after an SSH->HTTPS conversion - produces the SAME id and
 * the hub dedupes rather than creating a duplicate. A readable slug plus a short hash of the canonical
 * form: readable in the portal, stable across protocol forms.
 */
export function deriveRepoId(gitUrl: string): string {
  const parsed = parseGitRemote(gitUrl);
  const canonical = parsed ? `${parsed.host}/${parsed.owner}/${parsed.repo}`.toLowerCase() : gitUrl.trim().toLowerCase();
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  const slug = (parsed ? parsed.repo : "repo").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return `${slug}-${hash}`;
}

// -- hub registration --------------------------------------------------------

/** Translate the hub's WebSocket URL to the HTTP twin its config surface lives on: `wss://` -> `https://`,
 *  `ws://` -> `http://`. A URL that is already HTTP(S) is left alone. Trailing slashes are trimmed so the
 *  endpoint path joins cleanly. The node dials `wss://api.dahrk.ai`, but `POST /config/api/repositories`
 *  is served over HTTPS on the same host. */
export function hubHttpBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (/^wss:\/\//i.test(trimmed)) return trimmed.replace(/^wss:\/\//i, "https://");
  if (/^ws:\/\//i.test(trimmed)) return trimmed.replace(/^ws:\/\//i, "http://");
  return trimmed;
}

/** The repo registration payload the hub's config surface takes (`packages/hub` `POST
 *  /config/api/repositories`): a stable id, a display name, the git URL to clone, and the default branch. */
export interface RepoFacts {
  id: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
}

/** The IO `registerRepo` needs, injected so it exercises against a fake `fetch` with no network. */
export interface RegisterDeps {
  fetch: typeof fetch;
}

/** What registering produced. `registered` is a fresh create; `already` is the idempotent no-op (the repo
 *  was there), optionally carrying `drift` when the hub's stored record differs from what we just derived;
 *  `error` is a hard failure with a message to print. */
export type RegisterResult =
  | { kind: "registered" }
  | { kind: "already"; drift?: { branch?: string; name?: string } }
  | { kind: "error"; message: string };

/** Read a response body as JSON, or undefined when it is empty / not JSON (a 409 may carry no body). */
async function readJson(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Compare the hub's stored record to the freshly-derived facts and surface any branch/name drift, so the
 *  caller can warn that the stored record looks stale (still a success - `repo add` does not overwrite). */
function driftOf(stored: Record<string, unknown> | undefined, repo: RepoFacts): { branch?: string; name?: string } | undefined {
  if (!stored) return undefined;
  const drift: { branch?: string; name?: string } = {};
  if (typeof stored.defaultBranch === "string" && stored.defaultBranch !== repo.defaultBranch) drift.branch = stored.defaultBranch;
  if (typeof stored.name === "string" && stored.name !== repo.name) drift.name = stored.name;
  return drift.branch || drift.name ? drift : undefined;
}

/**
 * Register a repo with the hub, idempotently. POSTs `{id, name, gitUrl, defaultBranch}` to
 * `${base}/config/api/repositories`, authenticated with the node's enrolment token.
 *
 * The status code decides the outcome: a `201` is a fresh registration; a `200` (the hub upserted an
 * existing record) or a `409` (it rejected the duplicate) are both the idempotent no-op - re-running must
 * never error or create a second record. Any other 2xx is treated as a registration; a 4xx/5xx is a
 * readable error. A stored record whose branch/name differ from ours surfaces as `drift` on the `already`
 * result, so a re-run against a stale record can warn without changing anything.
 */
export async function registerRepo(
  deps: RegisterDeps,
  args: { base: string; token: string; repo: RepoFacts },
): Promise<RegisterResult> {
  const url = `${args.base}/config/api/repositories`;
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${args.token}` },
      body: JSON.stringify(args.repo),
    });
  } catch (e) {
    return { kind: "error", message: `could not reach the hub at ${args.base}: ${(e as Error).message}` };
  }

  // Always read the body, in every branch: leaving it undrained keeps the keep-alive socket open, which
  // keeps the event loop alive and stops `dahrk repo add` from exiting after it has done its job.
  const stored = await readJson(res);

  // A 200 (upsert of an existing record) or a 409 (duplicate rejected) both mean "already there".
  if (res.status === 200 || res.status === 409) {
    const drift = driftOf(stored, args.repo);
    return { kind: "already", ...(drift ? { drift } : {}) };
  }
  if (res.ok) return { kind: "registered" };
  return { kind: "error", message: `the hub rejected the repo (HTTP ${res.status})` };
}
