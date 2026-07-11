/**
 * The node's local state file: the stable node id and the cached enrolment token that together let a
 * bare `dahrk start` re-attach after a one-time `dahrk start --token <t>`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistEnrolment,
  readPersistedToken,
  readState,
  resolveEnrolToken,
  stateFile,
  writeState,
} from "../src/state.ts";

/** Run `fn` against a throwaway state dir. */
function withStateDir(fn: (env: NodeJS.ProcessEnv, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-state-"));
  try {
    fn({ DAHRK_STATE_DIR: dir }, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a token welcomed by the hub is cached, so the next bare start re-attaches without --token", () => {
  withStateDir((env) => {
    assert.equal(resolveEnrolToken(env), undefined, "nothing cached before the first enrolment");
    // `start --token X` -> the hub welcomes -> onEnrolled fires.
    persistEnrolment(env, { token: "sket_abc" });
    // The next boot passes no flag and no env var.
    assert.equal(resolveEnrolToken(env), "sket_abc");
  });
});

test("an explicit token wins over the cached one, and re-enrolling overwrites the cache", () => {
  withStateDir((env) => {
    persistEnrolment(env, { token: "sket_old" });
    const withFlag = { ...env, DAHRK_ENROL_TOKEN: "sket_new" };
    assert.equal(resolveEnrolToken(withFlag), "sket_new", "the explicit token wins");
    persistEnrolment(withFlag, { token: "sket_new" }); // the hub welcomed the rotated token
    assert.equal(resolveEnrolToken(env), "sket_new", "the rotated token replaced the cached one");
  });
});

test("persisting a token preserves the node id (and vice versa)", () => {
  withStateDir((env, dir) => {
    writeState(env, { nodeId: "node-1" });
    persistEnrolment(env, { token: "sket_abc" });
    const state = readState(join(dir, "node.json"));
    assert.deepEqual(state, { nodeId: "node-1", enrolToken: "sket_abc" });
    writeState(env, { nodeId: "node-2" });
    assert.equal(readPersistedToken(env), "sket_abc", "rewriting the id keeps the token");
  });
});

test("the state file holds a secret, so it is written 0600", () => {
  withStateDir((env, dir) => {
    persistEnrolment(env, { token: "sket_abc" });
    assert.equal(statSync(join(dir, "node.json")).mode & 0o777, 0o600);
  });
});

test("a world-readable node.json from an older client is tightened to 0600 on write", () => {
  withStateDir((env, dir) => {
    const file = join(dir, "node.json");
    writeFileSync(file, `${JSON.stringify({ nodeId: "node-1" })}\n`, { mode: 0o644 });
    persistEnrolment(env, { token: "sket_abc" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readState(file).nodeId, "node-1", "the pre-existing id survived");
  });
});

test("--ephemeral never reads the cached token", () => {
  withStateDir((env) => {
    persistEnrolment(env, { token: "sket_abc" });
    assert.equal(resolveEnrolToken(env, { ephemeral: true }), undefined);
    assert.equal(
      resolveEnrolToken({ ...env, DAHRK_ENROL_TOKEN: "sket_env" }, { ephemeral: true }),
      "sket_env",
      "an explicit token is still honoured under --ephemeral",
    );
  });
});

test("re-persisting the same token is a no-op (a steady-state reconnect does no write)", () => {
  withStateDir((env, dir) => {
    const file = join(dir, "node.json");
    persistEnrolment(env, { token: "sket_abc" });
    const before = statSync(file).mtimeMs;
    const raw = readFileSync(file, "utf8");
    persistEnrolment(env, { token: "sket_abc" });
    assert.equal(statSync(file).mtimeMs, before, "the file was not rewritten");
    assert.equal(readFileSync(file, "utf8"), raw);
  });
});

test("the welcome's identity is cached too, so `status` can name the node without dialling", () => {
  withStateDir((env) => {
    persistEnrolment(env, { token: "sket_abc", name: "local-20a818f1", tenantId: "t_default" });
    const state = readState(stateFile(env));
    assert.equal(state.name, "local-20a818f1");
    assert.equal(state.tenantId, "t_default");
  });
});

test("a re-welcome that only renames the node rewrites the cache, keeping the token", () => {
  withStateDir((env) => {
    persistEnrolment(env, { token: "sket_abc", name: "old-name", tenantId: "t_default" });
    persistEnrolment(env, { token: "sket_abc", name: "new-name", tenantId: "t_default" });
    const state = readState(stateFile(env));
    assert.equal(state.name, "new-name", "the rename landed");
    assert.equal(state.enrolToken, "sket_abc", "the token survived the rename");
  });
});

test("a corrupt state file reads as empty rather than wedging the boot", () => {
  withStateDir((env, dir) => {
    writeFileSync(join(dir, "node.json"), "{ not json");
    assert.deepEqual(readState(join(dir, "node.json")), {});
    assert.equal(resolveEnrolToken(env), undefined);
  });
});

test("readState on a missing file is empty, and stateFile lands under the state dir", () => {
  withStateDir((env, dir) => {
    assert.equal(stateFile(env), join(dir, "node.json"));
    assert.equal(existsSync(stateFile(env)), false);
    assert.deepEqual(readState(stateFile(env)), {});
  });
});
