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
import type { RunnerContext } from "@dahrk/contracts";

/**
 * A brokered API-key provider from the auth-profile hint. The credential itself is NOT here: it rides
 * in `runtimeEnv` under `envVar`, so the raw secret stays a process env value the agent never sees.
 */
export interface ApiKeyProviderHint {
  kind: "api_key";
  /** Pi provider id, e.g. `anthropic`, `openrouter`, `moonshot`, `groq`. */
  provider: string;
  /** The `runtimeEnv` key carrying the raw secret for this provider. */
  envVar: string;
  /** Base URL for a provider Pi ships no built-in for; drives a `models.json` custom-provider entry. */
  baseUrl?: string;
  /** Custom models to register under this provider (only meaningful with `baseUrl`). */
  models?: CustomProviderModel[];
  /** Extra request headers for the custom provider. */
  headers?: Record<string, string>;
}

/** A minimal custom-model definition, matching Pi's `models.json` provider `models[]` shape. Only
 *  `id` is required; the rest is passed through to Pi verbatim. */
export interface CustomProviderModel {
  id: string;
  [key: string]: unknown;
}

/**
 * A brokered OAuth-subscription provider from the auth-profile hint. The token material is persisted
 * into a hermetic `auth.json`; Pi refreshes it itself from `refresh`.
 */
export interface OAuthProviderHint {
  kind: "oauth";
  /** Pi OAuth provider id, e.g. `openai-chatgpt`, `github-copilot`, `gemini`. */
  provider: string;
  /** OAuth access token. */
  access: string;
  /** OAuth refresh token. */
  refresh: string;
  /** Absolute expiry (epoch ms), as Pi's `auth.json` records it. */
  expires: number;
  /** Any additional provider-specific fields Pi persists alongside the tokens (e.g. an endpoint). */
  extra?: Record<string, unknown>;
}

export type ProviderHint = ApiKeyProviderHint | OAuthProviderHint;

/** The auth-profile hint the broker mints (DHK-509) and threads onto the runner ctx. It is the SOLE
 *  source of provider identity for the Pi adapter. */
export interface PiAuthHint {
  providers: ProviderHint[];
  /**
   * The selected auth profile's `defaultModel`, if it set one.
   *
   * This is a FALLBACK, not an override. A stage names a tier alias (`sonnet`, `opus`) which Pi
   * resolves against its whole registry - and those aliases land on providers the brokered auth may not
   * cover at all (`sonnet` resolves to amazon-bedrock). `pickAuthedModel` first tries to preserve the
   * stage's intent by matching the resolved model's family against what the auth can actually reach;
   * only when nothing matches does it fall back to this. That is what lets a pool switch from an
   * Anthropic key to a Codex subscription without editing a single workflow.
   */
  defaultModel?: string;
}

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
 * The runner-ctx field carrying the auth-profile hint (DHK-509). It is not yet in the published
 * `@dahrk/contracts` (`^0.4.0`), so it is read here through a narrow structural cast: the accessor is
 * the single seam the rest of the adapter goes through, so when contracts ships the field only this
 * line changes. Absent on ambient/self-managed nodes (Pi then resolves against the operator's config).
 */
export function readAuthHint(ctx: RunnerContext): PiAuthHint | undefined {
  return (ctx as { runtimeAuth?: PiAuthHint }).runtimeAuth;
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
