/**
 * runtime auto-detect. We drive the real `detectRuntimes` against a throwaway PATH containing
 * only the fake runtime CLIs we choose, so the probe result is deterministic and hermetic (no reliance
 * on what happens to be installed on the test host). Each fake `<cmd>` is a tiny executable script that
 * exits 0 on `--version`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntimes, probeRuntimeStatuses } from "../src/detect-runtimes.js";

/** Build a temp bin dir holding a passing fake CLI per name, prepend it to PATH, run fn, then clean up
 *  and restore PATH. */
async function withFakeBins(names: string[], fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-detect-"));
  for (const name of names) {
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }
  const prevPath = process.env.PATH;
  // Only our fake bins are visible, so a real installed runtime cannot leak into the result.
  process.env.PATH = dir;
  try {
    await fn();
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("advertises only the runtimes whose CLI responds", async () => {
  await withFakeBins(["claude", "pi"], async () => {
    const detected = await detectRuntimes(2000);
    assert.deepEqual(detected, ["claude-code", "pi"], "claude + pi present, codex absent");
  });
});

test("no installed runtimes -> empty set (never a false advertise)", async () => {
  await withFakeBins([], async () => {
    const detected = await detectRuntimes(2000);
    assert.deepEqual(detected, []);
  });
});

test("all three present -> all three, in stable order", async () => {
  await withFakeBins(["claude", "codex", "pi"], async () => {
    const detected = await detectRuntimes(2000);
    assert.deepEqual(detected, ["claude-code", "codex", "pi"]);
  });
});

test("probeRuntimeStatuses reports installed + version, absent runtimes as not-installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dahrk-status-"));
  // A fake `claude` that prints a version; `codex`/`pi` stay absent from the throwaway PATH.
  const p = join(dir, "claude");
  writeFileSync(p, '#!/bin/sh\necho "claude 9.9.9"\nexit 0\n');
  chmodSync(p, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const statuses = await probeRuntimeStatuses(2000);
    const byRuntime = Object.fromEntries(statuses.map((s) => [s.runtime, s]));
    assert.deepEqual(byRuntime["claude-code"], {
      runtime: "claude-code",
      cmd: "claude",
      installed: true,
      version: "claude 9.9.9",
    });
    assert.equal(byRuntime["codex"]?.installed, false);
    assert.equal(byRuntime["pi"]?.installed, false);
    assert.equal(byRuntime["codex"]?.version, undefined);
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
