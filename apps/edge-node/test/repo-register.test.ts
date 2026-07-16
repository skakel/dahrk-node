import { test } from "node:test";
import assert from "node:assert/strict";
import { hubHttpBase, registerRepo, type RepoFacts } from "../src/repo-add.ts";

// -- hubHttpBase (ws -> http twin) -------------------------------------------

test("hubHttpBase: wss becomes https", () => {
  assert.equal(hubHttpBase("wss://api.dahrk.ai"), "https://api.dahrk.ai");
});

test("hubHttpBase: ws becomes http, keeping the port", () => {
  assert.equal(hubHttpBase("ws://h:1"), "http://h:1");
});

test("hubHttpBase: a bare https URL passes through unchanged", () => {
  assert.equal(hubHttpBase("https://api.dahrk.ai"), "https://api.dahrk.ai");
});

test("hubHttpBase: trailing slashes are stripped so the endpoint path joins cleanly", () => {
  assert.equal(hubHttpBase("wss://api.dahrk.ai/"), "https://api.dahrk.ai");
  assert.equal(hubHttpBase("https://api.dahrk.ai///"), "https://api.dahrk.ai");
});

// -- registerRepo (fake fetch) -----------------------------------------------

const repo: RepoFacts = {
  id: "repo-abc123",
  name: "repo",
  gitUrl: "https://github.com/org/repo.git",
  defaultBranch: "main",
};

/** A fake `fetch` that records the calls it receives and returns a scripted response. */
function fakeFetch(response: { status: number; body?: unknown }): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      json: async () => response.body ?? {},
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

test("registerRepo: a 201 is a fresh registration", async () => {
  const { fetch, calls } = fakeFetch({ status: 201 });
  const result = await registerRepo({ fetch }, { base: "https://api.dahrk.ai", token: "tok", repo });
  assert.deepEqual(result, { kind: "registered" });
  // The request carried the token and the full body, to the config repositories endpoint.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.dahrk.ai/config/api/repositories");
  assert.equal(calls[0].init.method, "POST");
  assert.match(String((calls[0].init.headers as Record<string, string>).authorization), /tok/);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), repo);
});

test("registerRepo: a 200 for an already-present id is a no-op, not a duplicate", async () => {
  const { fetch, calls } = fakeFetch({ status: 200, body: { ...repo } });
  const result = await registerRepo({ fetch }, { base: "https://api.dahrk.ai", token: "tok", repo });
  assert.equal(result.kind, "already");
  assert.equal(calls.length, 1, "one POST, no retry");
});

test("registerRepo: a 409 conflict is treated as already-registered", async () => {
  const { fetch } = fakeFetch({ status: 409 });
  const result = await registerRepo({ fetch }, { base: "https://api.dahrk.ai", token: "tok", repo });
  assert.equal(result.kind, "already");
});

test("registerRepo: a 4xx/5xx is a readable error", async () => {
  const { fetch } = fakeFetch({ status: 500 });
  const result = await registerRepo({ fetch }, { base: "https://api.dahrk.ai", token: "tok", repo });
  assert.equal(result.kind, "error");
  assert.equal(result.kind === "error" && /500/.test(result.message), true);
});

test("registerRepo: a stored record with a different branch surfaces drift", async () => {
  const { fetch } = fakeFetch({ status: 200, body: { ...repo, defaultBranch: "develop", name: "old-name" } });
  const result = await registerRepo({ fetch }, { base: "https://api.dahrk.ai", token: "tok", repo });
  assert.equal(result.kind, "already");
  if (result.kind === "already") {
    assert.equal(result.drift?.branch, "develop");
    assert.equal(result.drift?.name, "old-name");
  }
});

test("registerRepo: a network failure is an error, not a throw", async () => {
  const fn = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const result = await registerRepo({ fetch: fn }, { base: "https://api.dahrk.ai", token: "tok", repo });
  assert.equal(result.kind, "error");
  assert.equal(result.kind === "error" && /ECONNREFUSED/.test(result.message), true);
});
