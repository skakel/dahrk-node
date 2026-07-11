/**
 * Secret scrubbing for everything the node logs.
 *
 * A node runs on the operator's own machine and holds the crown jewels: SSH keys, `gh` tokens,
 * `DAHRK_GIT_TOKEN`, the Anthropic keychain/OAuth session, MCP server keys. Until now the node logged
 * almost nothing, so there was little to leak. The moment we start logging git output, agent errors
 * and crash stacks, the log file itself becomes a credential-disclosure surface - and unlike a trace,
 * it is written to disk unencrypted and swept up by a support bundle.
 *
 * Every value that reaches a log sink passes through `scrubValue`. The policy is deliberately
 * over-eager: a redacted value is recoverable (re-run with more context), a leaked token is not.
 *
 * Adapted from cyrus's `sentryScrubber.ts` (Apache-2.0, credited in NOTICE), with two additions that
 * matter specifically for us and that the original does not cover:
 *
 *  - **Inline** token redaction. The original's `looksLikeToken` only fires when the WHOLE string is a
 *    token, which is the wrong shape for git: `fatal: Authentication failed for
 *    'https://ghp_xxx@github.com/o/r.git'` is not itself a token, so it would pass through intact.
 *    Since git errors are precisely what we are about to start logging, prefixed tokens are now
 *    redacted anywhere inside a string.
 *  - **URL credentials.** `https://user:password@host` appears in git remote URLs and in the errors
 *    that echo them. The userinfo segment is stripped.
 */

/** Substring patterns (lowercased) that mark an object key as sensitive; the value is dropped whole. */
const SENSITIVE_KEY_PATTERNS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "authorization",
  "auth_header",
  "cookie",
  "private_key",
  "privatekey",
  "client_secret",
  "clientsecret",
  "refresh_token",
  "access_token",
  "bearer",
  "credential",
  "enroltoken",
  "enrol_token",
];

export const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

/** Keys we must NOT redact despite matching a pattern above, because they are the identifiers that
 *  make a log joinable to a hub run. Without this, `credentialMode` (an enum: ambient|brokered) would
 *  be dropped by the "credential" pattern and the log would lose a field we actively want. */
const KEY_ALLOWLIST = new Set(["credentialmode"]);

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (KEY_ALLOWLIST.has(lower)) return false;
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Well-known token prefixes, matched ANYWHERE in a string (not just as the whole value). Ordered
 * longest-prefix-first so `github_pat_` is not half-eaten by a shorter alternative.
 */
const INLINE_TOKEN_RE =
  /\b(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|lin_(?:api|oauth)_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g;

/** `scheme://user:secret@host` -> `scheme://user:[REDACTED]@host`. Git remotes and their error echoes. */
const URL_CREDENTIAL_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;

/** A JWT: three base64url segments. Matched inline (it may sit inside an `Authorization:` line). */
const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/**
 * Redact secret-shaped substrings inside an otherwise innocuous string. This is the workhorse: most
 * of our leak risk is a token embedded in a git error or a shell command, not a bare token value.
 */
export function scrubString(s: string): string {
  return s
    .replace(URL_CREDENTIAL_RE, `$1$2:${REDACTED}@`)
    .replace(INLINE_TOKEN_RE, REDACTED)
    .replace(JWT_RE, REDACTED)
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, `Bearer ${REDACTED}`)
    .replace(/([?&](?:token|access_token|api_key|key|secret)=)[^&\s"']+/gi, `$1${REDACTED}`);
}

/** True if the whole string is an opaque credential we should drop entirely rather than pattern-edit. */
function looksLikeWholeToken(s: string): boolean {
  if (s.length < 20 || /\s/.test(s)) return false;
  return /^(gh[pousr]|github_pat)_/i.test(s) || /^xox[abprs]-/i.test(s) || /^glpat-/i.test(s) || /^lin_(api|oauth)_/i.test(s) || /^sk-/i.test(s);
}

/**
 * Recursively scrub a value. Keys matching a sensitive pattern are dropped whole; every string is
 * scrubbed inline regardless of its key, so a token that lands in an innocuously-named field
 * (`msg`, `stderr`, `command`) still does not survive.
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return looksLikeWholeToken(value) ? REDACTED : scrubString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;

  if (value instanceof Error) {
    // Preserve the Error shape (pino's serializer needs `message`/`stack`), but scrub both. A stack
    // frame can embed a token via a URL in the message line.
    const out = new Error(scrubString(value.message));
    out.name = value.name;
    if (value.stack) out.stack = scrubString(value.stack);
    return out;
  }

  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : scrubValue(v, depth + 1);
    }
    return out;
  }

  return value;
}
