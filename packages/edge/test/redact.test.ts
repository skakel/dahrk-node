/**
 * The scrubber is the thing standing between a node's git token and a support bundle the customer
 * emails us. These tests are the contract; treat a failure here as a security regression, not a nit.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED, scrubString, scrubValue } from "../src/redact.js";

const GH_TOKEN = "ghp_abcdefghij0123456789abcdefghij0123";
const ANT_KEY = "sk-ant-api03-abcdefghij0123456789abcdefg";

test("redacts a token embedded in a git remote URL inside an error message", () => {
  // The dominant real-world shape: git echoes the remote (with credentials) back in its failure.
  const msg = `fatal: Authentication failed for 'https://x-access-token:${GH_TOKEN}@github.com/o/r.git'`;
  const out = scrubString(msg);
  assert.ok(!out.includes(GH_TOKEN), `token survived: ${out}`);
  assert.ok(out.includes("github.com/o/r.git"), "should keep the useful part of the message");
});

test("redacts a bare prefixed token anywhere inside a longer string", () => {
  const out = scrubString(`cloning with token ${GH_TOKEN} failed`);
  assert.ok(!out.includes(GH_TOKEN));
  assert.ok(out.includes(REDACTED));
});

test("redacts an Anthropic key", () => {
  assert.ok(!scrubString(`ANTHROPIC_API_KEY=${ANT_KEY}`).includes(ANT_KEY));
});

test("redacts values under sensitive keys, whatever their shape", () => {
  const out = scrubValue({ enrolToken: "plain-looking-value", nested: { gitToken: GH_TOKEN } }) as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(out.enrolToken, REDACTED);
  assert.equal(out.nested?.gitToken, REDACTED);
});

test("keeps credentialMode, which merely matches the 'credential' pattern", () => {
  // Regression guard: over-eager key matching would drop a field we actively want in the log.
  const out = scrubValue({ credentialMode: "ambient" }) as Record<string, unknown>;
  assert.equal(out.credentialMode, "ambient");
});

test("scrubs an Error's message and stack while preserving the shape", () => {
  const err = new Error(`push failed: https://u:${GH_TOKEN}@github.com/o/r.git`);
  const out = scrubValue(err) as Error;
  assert.ok(out instanceof Error);
  assert.ok(!out.message.includes(GH_TOKEN));
  assert.ok(!(out.stack ?? "").includes(GH_TOKEN));
});

test("preserves the correlation ids a log is useless without", () => {
  const out = scrubValue({ runId: "run-1", stageId: "build", jobId: "j-1", attempt: 2 }) as Record<string, unknown>;
  assert.deepEqual(out, { runId: "run-1", stageId: "build", jobId: "j-1", attempt: 2 });
});

test("redacts a JWT and a Bearer header", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.ok(!scrubString(`Authorization: Bearer ${jwt}`).includes(jwt));
});
