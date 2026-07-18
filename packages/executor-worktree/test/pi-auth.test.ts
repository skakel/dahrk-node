/**
 * Pi auth-profile helper tests (DHK-511). These pure, SDK-free helpers are the crux of the slice:
 * the live embedded factory (`defaultCreatePiSession`) is never exercised by the unit suite (the
 * real `@earendil-works/pi-coding-agent` SDK makes live calls and is not driven here), so all the
 * new provider-resolution and config-file logic lives in `pi-auth.ts` and is proven in isolation -
 * mirroring how `pi-mappers.test.ts` / `pi-model-provider.test.ts` prove the other pure helpers.
 *
 * The behaviour under test: provider identity comes SOLELY from the broker hint (DHK-509), never from
 * inferring a provider out of an env-var name. API-key providers apply as runtime overrides;
 * OAuth-subscription providers persist an `auth.json` into a hermetic per-stage config dir that is
 * cleaned up on teardown; a provider Pi ships no built-in for gets a `models.json` custom-provider
 * entry from the hint's base URL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { RunnerContext } from "@dahrk/contracts";
import {
  readAuthHint,
  applyApiKeyAuth,
  buildAuthJson,
  buildCustomProviders,
  createStageConfigDir,
  cleanupStageConfigDir,
  writeStageAuthFile,
  writeStageCustomProviders,
  type PiAuthHint,
  type AuthStorageLike,
} from "../src/pi-auth.js";

/** Records `setRuntimeApiKey` calls so a test asserts on the OUTCOME (which provider got which key). */
class RecordingAuthStorage implements AuthStorageLike {
  calls: Array<[string, string]> = [];
  setRuntimeApiKey(provider: string, key: string): void {
    this.calls.push([provider, key]);
  }
}

// --- readAuthHint: the ctx accessor ------------------------------------------------------------

test("readAuthHint returns the hint threaded onto the ctx", () => {
  const hint: PiAuthHint = { providers: [{ kind: "api_key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }] };
  const ctx = { runtimeAuth: hint } as unknown as RunnerContext;
  assert.equal(readAuthHint(ctx), hint);
});

test("readAuthHint returns undefined on an ambient node that carries no hint", () => {
  const ctx = {} as RunnerContext;
  assert.equal(readAuthHint(ctx), undefined);
});

// --- applyApiKeyAuth: provider identity from the hint, not the env-var name --------------------

test("a default provider (anthropic) resolves from the hint and applies its runtimeEnv key", () => {
  const storage = new RecordingAuthStorage();
  const hint: PiAuthHint = { providers: [{ kind: "api_key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }] };
  applyApiKeyAuth(hint, { ANTHROPIC_API_KEY: "sk-ant" }, storage);
  assert.deepEqual(storage.calls, [["anthropic", "sk-ant"]]);
});

test("a non-default provider (openrouter) resolves to its Pi provider id and key", () => {
  const storage = new RecordingAuthStorage();
  const hint: PiAuthHint = { providers: [{ kind: "api_key", provider: "openrouter", envVar: "OPENROUTER_API_KEY" }] };
  applyApiKeyAuth(hint, { OPENROUTER_API_KEY: "sk-or" }, storage);
  assert.deepEqual(storage.calls, [["openrouter", "sk-or"]]);
});

test("Kimi (moonshot) - another non-default provider - resolves from the hint", () => {
  const storage = new RecordingAuthStorage();
  const hint: PiAuthHint = { providers: [{ kind: "api_key", provider: "moonshot", envVar: "MOONSHOT_API_KEY" }] };
  applyApiKeyAuth(hint, { MOONSHOT_API_KEY: "sk-kimi" }, storage);
  assert.deepEqual(storage.calls, [["moonshot", "sk-kimi"]]);
});

test("provider identity comes from the hint even when the env-var name says nothing about it", () => {
  // The whole point of the hint: the broker can carry the secret under an opaque var name and the
  // adapter still lands it on the right Pi provider. A static PROVIDER_BY_ENV table could never do this.
  const storage = new RecordingAuthStorage();
  const hint: PiAuthHint = { providers: [{ kind: "api_key", provider: "openrouter", envVar: "DAHRK_RUNTIME_KEY_1" }] };
  applyApiKeyAuth(hint, { DAHRK_RUNTIME_KEY_1: "sk-or" }, storage);
  assert.deepEqual(storage.calls, [["openrouter", "sk-or"]]);
});

test("several API-key providers in one hint each apply", () => {
  const storage = new RecordingAuthStorage();
  const hint: PiAuthHint = {
    providers: [
      { kind: "api_key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
      { kind: "api_key", provider: "groq", envVar: "GROQ_API_KEY" },
    ],
  };
  applyApiKeyAuth(hint, { ANTHROPIC_API_KEY: "sk-ant", GROQ_API_KEY: "sk-groq" }, storage);
  assert.deepEqual(storage.calls, [["anthropic", "sk-ant"], ["groq", "sk-groq"]]);
});

test("an API-key provider whose env var is absent from runtimeEnv is skipped, not thrown", () => {
  const storage = new RecordingAuthStorage();
  const hint: PiAuthHint = { providers: [{ kind: "api_key", provider: "openrouter", envVar: "OPENROUTER_API_KEY" }] };
  applyApiKeyAuth(hint, {}, storage); // the broker minted a hint but the key never arrived
  assert.deepEqual(storage.calls, []);
});

test("a hint-less (undefined) call applies nothing and does not throw", () => {
  const storage = new RecordingAuthStorage();
  applyApiKeyAuth(undefined, { ANTHROPIC_API_KEY: "sk-ant" }, storage);
  assert.deepEqual(storage.calls, []);
});

test("applyApiKeyAuth: undefined runtimeEnv (not just empty object) applies nothing and does not throw", () => {
  const storage = new RecordingAuthStorage();
  const hint: PiAuthHint = { providers: [{ kind: "api_key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }] };
  applyApiKeyAuth(hint, undefined, storage);
  assert.deepEqual(storage.calls, [], "undefined runtimeEnv is treated as {} via ?? fallback")
});

test("OAuth providers in the hint are not treated as API keys", () => {
  const storage = new RecordingAuthStorage();
  const hint: PiAuthHint = {
    providers: [{ kind: "oauth", provider: "openai-chatgpt", access: "at", refresh: "rt", expires: 111 }],
  };
  applyApiKeyAuth(hint, { OPENAI_API_KEY: "sk-should-not-be-used" }, storage);
  assert.deepEqual(storage.calls, [], "an OAuth subscription is applied via auth.json, never setRuntimeApiKey");
});

// --- buildAuthJson: the OAuth-subscription auth.json shape -------------------------------------

test("buildAuthJson emits a Pi oauth credential for a ChatGPT/Codex subscription", () => {
  const hint: PiAuthHint = {
    providers: [{ kind: "oauth", provider: "openai-chatgpt", access: "at-123", refresh: "rt-456", expires: 1893456000000 }],
  };
  assert.deepEqual(buildAuthJson(hint), {
    "openai-chatgpt": { type: "oauth", access: "at-123", refresh: "rt-456", expires: 1893456000000 },
  });
});

test("buildAuthJson carries provider-specific extra fields verbatim", () => {
  const hint: PiAuthHint = {
    providers: [
      { kind: "oauth", provider: "github-copilot", access: "at", refresh: "rt", expires: 5, extra: { endpoint: "https://api.githubcopilot.com" } },
    ],
  };
  assert.deepEqual(buildAuthJson(hint), {
    "github-copilot": { type: "oauth", access: "at", refresh: "rt", expires: 5, endpoint: "https://api.githubcopilot.com" },
  });
});

test("buildAuthJson maps several OAuth providers", () => {
  const hint: PiAuthHint = {
    providers: [
      { kind: "oauth", provider: "openai-chatgpt", access: "a1", refresh: "r1", expires: 1 },
      { kind: "oauth", provider: "gemini", access: "a2", refresh: "r2", expires: 2 },
    ],
  };
  assert.deepEqual(buildAuthJson(hint), {
    "openai-chatgpt": { type: "oauth", access: "a1", refresh: "r1", expires: 1 },
    gemini: { type: "oauth", access: "a2", refresh: "r2", expires: 2 },
  });
});

test("buildAuthJson returns undefined when the hint has no OAuth providers (nothing to persist)", () => {
  const hint: PiAuthHint = { providers: [{ kind: "api_key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }] };
  assert.equal(buildAuthJson(hint), undefined);
  assert.equal(buildAuthJson(undefined), undefined);
});

// --- buildCustomProviders: the models.json custom-provider entry ------------------------------

test("buildCustomProviders emits a models.json provider entry from a hint carrying a base URL", () => {
  const hint: PiAuthHint = {
    providers: [{ kind: "api_key", provider: "my-proxy", envVar: "PROXY_API_KEY", baseUrl: "https://proxy.example/v1" }],
  };
  assert.deepEqual(buildCustomProviders(hint), {
    providers: { "my-proxy": { baseUrl: "https://proxy.example/v1" } },
  });
});

test("buildCustomProviders carries custom models and headers when the hint supplies them", () => {
  const hint: PiAuthHint = {
    providers: [
      {
        kind: "api_key",
        provider: "my-proxy",
        envVar: "PROXY_API_KEY",
        baseUrl: "https://proxy.example/v1",
        headers: { "X-Extra": "1" },
        models: [{ id: "custom-model-1", name: "Custom 1" }],
      },
    ],
  };
  assert.deepEqual(buildCustomProviders(hint), {
    providers: {
      "my-proxy": {
        baseUrl: "https://proxy.example/v1",
        headers: { "X-Extra": "1" },
        models: [{ id: "custom-model-1", name: "Custom 1" }],
      },
    },
  });
});

test("buildCustomProviders emits entries for multiple API-key providers that each carry a base URL", () => {
  const hint: PiAuthHint = {
    providers: [
      { kind: "api_key", provider: "proxy-a", envVar: "PROXY_A_KEY", baseUrl: "https://proxy-a.example/v1" },
      { kind: "api_key", provider: "proxy-b", envVar: "PROXY_B_KEY", baseUrl: "https://proxy-b.example/v1", headers: { "X-Org": "acme" } },
    ],
  };
  assert.deepEqual(buildCustomProviders(hint), {
    providers: {
      "proxy-a": { baseUrl: "https://proxy-a.example/v1" },
      "proxy-b": { baseUrl: "https://proxy-b.example/v1", headers: { "X-Org": "acme" } },
    },
  });
});

test("buildCustomProviders with a mixed hint: only the api_key-with-baseUrl provider enters models.json, OAuth is skipped", () => {
  const hint: PiAuthHint = {
    providers: [
      { kind: "api_key", provider: "my-proxy", envVar: "PROXY_KEY", baseUrl: "https://proxy.example/v1" },
      { kind: "oauth", provider: "openai-chatgpt", access: "at", refresh: "rt", expires: 1 },
    ],
  };
  assert.deepEqual(buildCustomProviders(hint), {
    providers: { "my-proxy": { baseUrl: "https://proxy.example/v1" } },
  });
});

test("buildCustomProviders returns undefined when no API-key provider needs a base URL", () => {
  const hint: PiAuthHint = {
    providers: [
      { kind: "api_key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }, // built-in, no base URL
      { kind: "oauth", provider: "openai-chatgpt", access: "a", refresh: "r", expires: 1 },
    ],
  };
  assert.equal(buildCustomProviders(hint), undefined);
  assert.equal(buildCustomProviders(undefined), undefined);
});

// --- Hermetic config dir: create outside ~/.pi, cleaned up on teardown ------------------------

test("createStageConfigDir makes a fresh dir under os.tmpdir(), never inside ~/.pi", () => {
  const dir = createStageConfigDir();
  try {
    assert.ok(existsSync(dir), "the config dir exists");
    assert.ok(dir.startsWith(tmpdir()), "it lives under the OS temp dir");
    assert.ok(!dir.startsWith(join(homedir(), ".pi")), "it never inherits the machine-global ~/.pi");
  } finally {
    cleanupStageConfigDir(dir);
  }
});

test("createStageConfigDir hands out a distinct dir each call", () => {
  const a = createStageConfigDir();
  const b = createStageConfigDir();
  try {
    assert.notEqual(a, b);
  } finally {
    cleanupStageConfigDir(a);
    cleanupStageConfigDir(b);
  }
});

test("cleanupStageConfigDir removes the dir and everything written into it", () => {
  const dir = createStageConfigDir();
  const hint: PiAuthHint = {
    providers: [{ kind: "oauth", provider: "openai-chatgpt", access: "at", refresh: "rt", expires: 1 }],
  };
  writeStageAuthFile(dir, hint);
  assert.ok(existsSync(join(dir, "auth.json")), "auth.json was written into the config dir");
  cleanupStageConfigDir(dir);
  assert.ok(!existsSync(dir), "the whole config dir (and its auth.json) is gone after teardown");
});

test("cleanupStageConfigDir is a no-op on an already-removed dir (safe on double teardown)", () => {
  const dir = createStageConfigDir();
  cleanupStageConfigDir(dir);
  assert.doesNotThrow(() => cleanupStageConfigDir(dir), "cleanup must survive running on both settle and cancel");
});

// --- writeStageAuthFile: the OAuth path lands the file in the config dir -----------------------

test("writeStageAuthFile writes the OAuth auth.json into the config dir and returns its path", () => {
  const dir = createStageConfigDir();
  try {
    const hint: PiAuthHint = {
      providers: [{ kind: "oauth", provider: "openai-chatgpt", access: "at-9", refresh: "rt-9", expires: 42 }],
    };
    const path = writeStageAuthFile(dir, hint);
    assert.equal(path, join(dir, "auth.json"));
    const written = JSON.parse(readFileSync(path!, "utf8"));
    assert.deepEqual(written, { "openai-chatgpt": { type: "oauth", access: "at-9", refresh: "rt-9", expires: 42 } });
  } finally {
    cleanupStageConfigDir(dir);
  }
});

test("writeStageAuthFile writes nothing (and returns undefined) when there are no OAuth providers", () => {
  const dir = createStageConfigDir();
  try {
    const hint: PiAuthHint = { providers: [{ kind: "api_key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }] };
    assert.equal(writeStageAuthFile(dir, hint), undefined);
    assert.deepEqual(readdirSync(dir), [], "an API-key-only stage never persists an auth.json");
  } finally {
    cleanupStageConfigDir(dir);
  }
});

test("writeStageCustomProviders writes models.json only when a base-URL provider is present", () => {
  const dir = createStageConfigDir();
  try {
    const withBase: PiAuthHint = {
      providers: [{ kind: "api_key", provider: "my-proxy", envVar: "PROXY_API_KEY", baseUrl: "https://proxy.example/v1" }],
    };
    const path = writeStageCustomProviders(dir, withBase);
    assert.equal(path, join(dir, "models.json"));
    assert.deepEqual(JSON.parse(readFileSync(path!, "utf8")), {
      providers: { "my-proxy": { baseUrl: "https://proxy.example/v1" } },
    });

    const noBase: PiAuthHint = { providers: [{ kind: "api_key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" }] };
    const dir2 = createStageConfigDir();
    try {
      assert.equal(writeStageCustomProviders(dir2, noBase), undefined);
      assert.deepEqual(readdirSync(dir2), [], "no models.json when no provider needs a custom base URL");
    } finally {
      cleanupStageConfigDir(dir2);
    }
  } finally {
    cleanupStageConfigDir(dir);
  }
});

test("the written auth.json never contains an API key (secrets that route via setRuntimeApiKey stay off disk)", () => {
  const dir = createStageConfigDir();
  try {
    const hint: PiAuthHint = {
      providers: [
        { kind: "api_key", provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
        { kind: "oauth", provider: "openai-chatgpt", access: "at", refresh: "rt", expires: 1 },
      ],
    };
    const path = writeStageAuthFile(dir, hint);
    const raw = readFileSync(path!, "utf8");
    assert.ok(!raw.includes("api_key"), "the API-key provider is never persisted into auth.json");
    assert.ok(!raw.includes("anthropic"), "only the OAuth subscription lands on disk");
  } finally {
    cleanupStageConfigDir(dir);
  }
});
