/**
 * Pi auth-profile resolution (DHK-511): turn a selected auth profile's broker hint into the auth
 * material Pi actually reads. This is the whole provider surface Pi supports - not just the four-key
 * table the adapter used to hard-code (`PROVIDER_BY_ENV`) - driven by an explicit hint minted by the
 * broker (DHK-509), so provider identity is DECLARED, never inferred from an env-var name.
 *
 * Three shapes of provider, three destinations:
 *   - API-key providers (OpenRouter, Kimi, Mistral, Groq, ...) -> `AuthStorage.setRuntimeApiKey`
 *     (a runtime override, never persisted); the raw secret rides in `runtimeEnv` and never reaches
 *     the agent's own tool calls.
 *   - API-key providers Pi ships no built-in for -> a `models.json` custom-provider entry built from
 *     the hint's base URL, so Pi can reach the endpoint.
 *   - OAuth-subscription providers (ChatGPT/Codex, GitHub Copilot, Gemini) -> a persisted `auth.json`
 *     written into a hermetic per-stage config dir (never the machine-global `~/.pi`), cleaned up on
 *     teardown.
 *
 * Everything here is pure and SDK-free (typed against minimal local interfaces, mirroring the
 * `PiModelLike` pattern in pi-adapter.ts) so it is unit-tested in isolation without a live Pi install:
 * the live factory `defaultCreatePiSession` is a thin caller of these helpers.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApiKeyProviderHint,
  CustomProviderModel,
  OAuthProviderHint,
  ProviderHint,
  RunnerContext,
  RuntimeAuthHint,
} from "@dahrk/contracts";

// The hint types used to be mirrored here because the field they ride on did not exist in the
// published `@dahrk/contracts`. Since 0.7.0 the contract declares `RuntimeAuthHint` (and its member
// shapes) AND `RunnerContext.runtimeAuth`, so the mirror is gone: these are the contract's own types,
// re-exported under the adapter's existing names to keep this package's public surface stable. The
// harness's `runtime-auth.ts` documents each field (and its load-bearing MIRROR RULE); read it there.
export type { ApiKeyProviderHint, CustomProviderModel, OAuthProviderHint, ProviderHint } from "@dahrk/contracts";

/** The auth-profile hint the broker mints (DHK-509) and threads onto the runner ctx. It is the SOLE
 *  source of provider identity for the Pi adapter. The contract's `RuntimeAuthHint`, aliased so the
 *  adapter (and its `@dahrk/executor-worktree` re-export) keep the `PiAuthHint` name. */
export type PiAuthHint = RuntimeAuthHint;

/** The subset of Pi's `AuthStorage` the API-key path drives; kept local so the helper is SDK-free. */
export interface AuthStorageLike {
  /** Set a runtime API-key override (highest priority, not persisted to disk). */
  setRuntimeApiKey(provider: string, key: string): void;
}

/** A Pi `auth.json` credential record (the on-disk shape Pi loads). */
type PiOAuthCredential = { type: "oauth"; access: string; refresh: string; expires: number } & Record<string, unknown>;
/** A Pi `models.json` document: a map of provider name to its custom-provider config. */
interface PiModelsConfig {
  providers: Record<string, PiCustomProviderConfig>;
}
interface PiCustomProviderConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  models?: CustomProviderModel[];
}

/**
 * The runner-ctx field carrying the auth-profile hint (DHK-509). A plain typed read since
 * `@dahrk/contracts` 0.7.0 declared `RunnerContext.runtimeAuth` (it was a structural cast against an
 * undeclared field before). Kept as the single accessor the rest of the adapter goes through. Absent
 * on ambient/self-managed nodes (Pi then resolves against the operator's config).
 */
export function readAuthHint(ctx: RunnerContext): PiAuthHint | undefined {
  return ctx.runtimeAuth;
}

/**
 * Apply every brokered API-key provider in the hint as a runtime override on `AuthStorage`. Provider
 * identity is taken from the hint (`provider`), never inferred from the env-var name, and the secret is
 * read from `runtimeEnv` under the hint's `envVar`. A provider whose key never arrived is skipped
 * (the broker minted a hint but the value is absent); a missing hint applies nothing. OAuth providers
 * are ignored here - they persist via `auth.json`, not `setRuntimeApiKey`.
 */
export function applyApiKeyAuth(
  hint: PiAuthHint | undefined,
  runtimeEnv: Record<string, string> | undefined,
  authStorage: AuthStorageLike,
): void {
  const env = runtimeEnv ?? {};
  for (const p of hint?.providers ?? []) {
    if (p.kind !== "api_key") continue;
    const value = env[p.envVar];
    if (value) authStorage.setRuntimeApiKey(p.provider, value);
  }
}

/**
 * Build the Pi `auth.json` content from the hint's OAuth-subscription providers, or `undefined` when
 * there are none (nothing to persist). Each provider's `extra` fields are folded in verbatim so a
 * provider that persists more than the base token triplet (e.g. an endpoint) round-trips.
 */
export function buildAuthJson(hint: PiAuthHint | undefined): Record<string, PiOAuthCredential> | undefined {
  const entries: Array<[string, PiOAuthCredential]> = [];
  for (const p of hint?.providers ?? []) {
    if (p.kind !== "oauth") continue;
    entries.push([p.provider, { type: "oauth", ...p.extra, access: p.access, refresh: p.refresh, expires: p.expires }]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * Build the Pi `models.json` content from any API-key provider that carries a base URL (a provider Pi
 * ships no built-in for), or `undefined` when none does. Pi requires `baseUrl` on a custom provider, so
 * a provider without one is a built-in and contributes nothing here.
 */
export function buildCustomProviders(hint: PiAuthHint | undefined): PiModelsConfig | undefined {
  const providers: Record<string, PiCustomProviderConfig> = {};
  for (const p of hint?.providers ?? []) {
    if (p.kind !== "api_key" || !p.baseUrl) continue;
    providers[p.provider] = {
      baseUrl: p.baseUrl,
      ...(p.headers ? { headers: p.headers } : {}),
      ...(p.models ? { models: p.models } : {}),
    };
  }
  return Object.keys(providers).length ? { providers } : undefined;
}

/**
 * Create a fresh, empty per-stage Pi config dir under the OS temp dir - NEVER `~/.pi`. Pointing Pi at
 * this dir keeps the stage hermetic: it does not inherit the machine-global auth/models config.
 */
export function createStageConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "dahrk-pi-"));
}

/**
 * Remove a per-stage config dir and everything written into it (the OAuth `auth.json`, any
 * `models.json`). Idempotent and never throws, so it can run on BOTH the normal settle and cancel
 * paths without a double-teardown hazard.
 */
export function cleanupStageConfigDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Persist the OAuth-subscription `auth.json` into `dir`, returning its path, or `undefined` when the
 * hint has no OAuth providers (nothing is written). The cleanup above removes it on teardown.
 */
export function writeStageAuthFile(dir: string, hint: PiAuthHint | undefined): string | undefined {
  const authJson = buildAuthJson(hint);
  if (!authJson) return undefined;
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(authJson, null, 2));
  return path;
}

/**
 * Persist the custom-provider `models.json` into `dir`, returning its path, or `undefined` when no
 * API-key provider needs a custom base URL (nothing is written).
 */
export function writeStageCustomProviders(dir: string, hint: PiAuthHint | undefined): string | undefined {
  const models = buildCustomProviders(hint);
  if (!models) return undefined;
  const path = join(dir, "models.json");
  writeFileSync(path, JSON.stringify(models, null, 2));
  return path;
}
