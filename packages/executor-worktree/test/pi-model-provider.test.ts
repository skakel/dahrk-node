/**
 * `pickAuthedModel`: land a resolved model on a provider we can actually authenticate to.
 *
 * The bug it exists for, stated once: `resolveCliModel` resolves an alias against the whole Pi
 * registry (~1000 models, ~30 providers), and the bare aliases every Dahrk workflow uses land on
 * **amazon-bedrock** - `opus` resolves to `us.anthropic.claude-opus-4-8`. A managed node is brokered an
 * *Anthropic* key, so Pi asked Bedrock for a credential that does not exist and the stage died on its
 * first turn with "No API key found for amazon-bedrock", having spent nothing and produced no trace.
 *
 * The ids below are the real ones, read out of the built edge image.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pickAuthedModel, type PiModelLike } from "../src/pi-adapter.js";

/** What `registry.getAvailable()` returns when the broker injected only an ANTHROPIC_API_KEY. */
const ANTHROPIC_AVAILABLE: PiModelLike[] = [
  { id: "claude-haiku-4-5", provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic" },
  { id: "claude-opus-4-8", provider: "anthropic" },
  { id: "claude-sonnet-5", provider: "anthropic" },
];

const BEDROCK_OPUS: PiModelLike = { id: "us.anthropic.claude-opus-4-8", provider: "amazon-bedrock" };
const BEDROCK_SONNET: PiModelLike = { id: "us.anthropic.claude-sonnet-5", provider: "amazon-bedrock" };
const BEDROCK_HAIKU: PiModelLike = {
  id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  provider: "amazon-bedrock",
};

test("the alias resolved to Bedrock, but we hold an Anthropic key: use the Anthropic model", () => {
  assert.deepEqual(pickAuthedModel(BEDROCK_OPUS, ANTHROPIC_AVAILABLE), {
    id: "claude-opus-4-8",
    provider: "anthropic",
  });
  assert.deepEqual(pickAuthedModel(BEDROCK_SONNET, ANTHROPIC_AVAILABLE), {
    id: "claude-sonnet-5",
    provider: "anthropic",
  });
});

test("a region prefix and a -v1:0 revision do not hide the family", () => {
  // us.anthropic.claude-haiku-4-5-20251001-v1:0 IS claude-haiku-4-5-20251001.
  assert.deepEqual(pickAuthedModel(BEDROCK_HAIKU, ANTHROPIC_AVAILABLE), {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
  });
});

test("a model already on an authed provider is returned untouched", () => {
  const anthropicOpus: PiModelLike = { id: "claude-opus-4-8", provider: "anthropic" };
  assert.equal(pickAuthedModel(anthropicOpus, ANTHROPIC_AVAILABLE), anthropicOpus);
});

test("nothing available (ambient node, no brokered key) is a no-op: Pi resolves as it always did", () => {
  assert.equal(pickAuthedModel(BEDROCK_OPUS, []), BEDROCK_OPUS);
  assert.equal(pickAuthedModel(BEDROCK_OPUS, undefined), BEDROCK_OPUS);
});

test("no available model matches: leave Pi's resolution alone rather than inventing one", () => {
  // We hold an OpenAI key; the stage asked for a Claude model. Substituting a GPT for it would be a
  // silent, wrong answer - so we do not. Pi raises its own "no API key for amazon-bedrock" error.
  const openaiAvailable: PiModelLike[] = [{ id: "gpt-5", provider: "openai" }];
  assert.equal(pickAuthedModel(BEDROCK_OPUS, openaiAvailable), BEDROCK_OPUS);
});

test("an unresolved model stays unresolved", () => {
  assert.equal(pickAuthedModel(undefined, ANTHROPIC_AVAILABLE), undefined);
});

test("the same model reached through a different provider is still the same model", () => {
  // Vertex packages Claude too; if that were the key we held, the family match must still land.
  const vertexAvailable: PiModelLike[] = [
    { id: "claude-opus-4-8", provider: "google-vertex" },
  ];
  assert.deepEqual(pickAuthedModel(BEDROCK_OPUS, vertexAvailable), {
    id: "claude-opus-4-8",
    provider: "google-vertex",
  });
});

// --- The profile fallback (Codex subscription) --------------------------------------------------
//
// The family match above can only work when the brokered provider serves the SAME model line. A
// ChatGPT/Codex subscription does not: `sonnet` still resolves to Bedrock Claude, and no
// `openai-codex` model is in the `claude` family, so family matching finds nothing and the resolution
// stays on Bedrock - the exact "No API key found for amazon-bedrock" failure again, now for a
// different reason. The selected auth profile's `defaultModel` is the last resort that closes it.

/** What `getAvailable()` returns once a Codex subscription's `auth.json` is in place. */
const CODEX_AVAILABLE: PiModelLike[] = [
  { id: "gpt-5.4", provider: "openai-codex" },
  { id: "gpt-5.5", provider: "openai-codex" },
  { id: "gpt-5.6-luna", provider: "openai-codex" },
];

test("a Codex subscription cannot serve a Claude alias: fall back to the profile's model", () => {
  assert.deepEqual(pickAuthedModel(BEDROCK_SONNET, CODEX_AVAILABLE, "gpt-5.5"), {
    id: "gpt-5.5",
    provider: "openai-codex",
  });
});

test("the fallback is a LAST resort: a family match still wins over it", () => {
  // Holding an Anthropic key, `opus` must still land on Claude even though a profile names a fallback.
  // Preferring the fallback here would silently downgrade every stage that could have run as authored.
  assert.deepEqual(pickAuthedModel(BEDROCK_OPUS, ANTHROPIC_AVAILABLE, "gpt-5.5"), {
    id: "claude-opus-4-8",
    provider: "anthropic",
  });
});

test("an authenticable provider is never second-guessed, fallback or not", () => {
  const codexResolved: PiModelLike = { id: "gpt-5.4", provider: "openai-codex" };
  assert.equal(pickAuthedModel(codexResolved, CODEX_AVAILABLE, "gpt-5.5"), codexResolved);
});

test("a fallback naming a model the auth cannot reach is ignored, so Pi raises its own error", () => {
  // Never invent a model: an unmatched fallback leaves the resolution exactly as Pi made it, so the
  // error the operator sees names the real problem instead of a substitution we made up.
  assert.equal(pickAuthedModel(BEDROCK_SONNET, CODEX_AVAILABLE, "gpt-4-nonexistent"), BEDROCK_SONNET);
});

test("no fallback given: behaviour is exactly as before", () => {
  assert.equal(pickAuthedModel(BEDROCK_SONNET, CODEX_AVAILABLE), BEDROCK_SONNET);
});
