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

test("a transient probe miss is retried, not read as absent (DHK-390)", async () => {
  // The incident: a working `claude` CLI that answers slowly on ONE invocation (a cold Node CLI on a
  // host mid-IO-churn) exceeded the 3s probe and was dropped from the advertisement for the life of
  // the process. This fake reproduces that exactly: its first `--version` sleeps past the probe
  // timeout (so the probe times out and kills it); a marker file makes every later call return at
  // once. With a retry, the runtime must still be detected.
  const dir = mkdtempSync(join(tmpdir(), "dahrk-transient-"));
  const marker = join(dir, "claude.called");
  const claude = join(dir, "claude");
  writeFileSync(
    claude,
    `#!/bin/sh\nif [ -f "${marker}" ]; then exit 0; fi\n: > "${marker}"\nsleep 5\nexit 0\n`,
  );
  chmodSync(claude, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    // 200ms timeout so the first (sleeping) call times out fast; 2 attempts so the retry succeeds.
    const detected = await detectRuntimes(200, 2);
    assert.deepEqual(detected, ["claude-code"], "a single slow probe must not drop a working runtime");
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a runtime whose CLI always errors is still not advertised (preserved behaviour)", async () => {
  // The retry must not resurrect a genuinely-broken runtime: a CLI that is present but exits non-zero
  // on every `--version` is retried and, still failing, correctly left out of the advertisement.
  const dir = mkdtempSync(join(tmpdir(), "dahrk-broken-"));
  const claude = join(dir, "claude");
  writeFileSync(claude, "#!/bin/sh\nexit 1\n");
  chmodSync(claude, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const detected = await detectRuntimes(2000, 2);
    assert.deepEqual(detected, [], "an always-erroring CLI must not be advertised");
  } finally {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  }
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
