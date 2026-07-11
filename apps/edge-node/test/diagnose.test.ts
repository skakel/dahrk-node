/**
 * The support bundle is the one artefact a customer is asked to send us, so its contract is a promise:
 * no enrolment token, no secrets, no source. These tests are that promise, written down.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBundle, runDiagnose, tailJsonl, type DiagnoseDeps } from "../src/diagnose.ts";

const TOKEN = "ghp_abcdefghij0123456789abcdefghij0123";

/** An in-memory filesystem, so the bundle is tested without touching a disk. */
function deps(files: Record<string, string>, out: string[] = []): DiagnoseDeps & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  return {
    stateFile: "/s/node.json",
    jsonlFile: "/s/logs/node.jsonl",
    crashDir: "/s/logs/crashes",
    outFile: "/out/bundle.json",
    clientVersion: "0.1.8",
    readFile: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    listDir: (p) =>
      Object.keys(files)
        .filter((f) => f.startsWith(`${p}/`))
        .map((f) => f.slice(p.length + 1)),
    exists: (p) => files[p] !== undefined || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    writeFile: (p, c) => void (written[p] = c),
    out: (line) => void out.push(line),
    written,
  };
}

test("the enrolment token is removed from the bundle, not merely redacted", async () => {
  const bundle = await buildBundle(
    deps({
      "/s/node.json": JSON.stringify({ nodeId: "n-1", name: "brave-otter", tenantId: "t_1", enrolToken: "tok_secret" }),
    }),
  );
  // Removed, not "[REDACTED]": a marker still tells you a token is there and roughly how long it was.
  assert.ok(!("enrolToken" in bundle.node.state), "enrolToken must not be a key in the bundle at all");
  assert.equal(bundle.node.state.nodeId, "n-1");
  assert.equal(bundle.node.state.name, "brave-otter");
});

test("a secret that reached a log line does not reach the bundle", async () => {
  const bundle = await buildBundle(
    deps({
      "/s/logs/node.jsonl": `${JSON.stringify({ level: 50, time: "t", msg: `push failed https://u:${TOKEN}@github.com/o/r` })}\n`,
    }),
  );
  assert.ok(!JSON.stringify(bundle).includes(TOKEN), "the token reached the bundle");
});

test("crash records are collected, and are the thing a bundle leads with", async () => {
  const bundle = await buildBundle(
    deps({
      "/s/logs/crashes/2026-07-11.json": JSON.stringify({ kind: "uncaughtException", message: "boom" }),
    }),
  );
  assert.equal(bundle.crashes.length, 1);
  assert.deepEqual(bundle.crashes[0], { kind: "uncaughtException", message: "boom" });
});

test("what could not be collected is said out loud, not silently omitted", async () => {
  // An empty section is ambiguous: "no crashes" or "could not read them?" Ambiguity costs a round trip.
  const bundle = await buildBundle(deps({}));
  assert.ok(bundle.warnings.some((w) => w.includes("never enrolled")));
  assert.ok(bundle.warnings.some((w) => w.includes("node.jsonl")));
});

test("tailJsonl keeps the tail and survives a torn final line", () => {
  const raw = `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ a: 2 })}\n{"a":3`; // last line torn mid-write
  assert.deepEqual(tailJsonl(raw, 10), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(tailJsonl(raw, 1), [{ a: 2 }]);
});

test("runDiagnose writes the file and says plainly that nothing was sent", async () => {
  const out: string[] = [];
  const d = deps({ "/s/node.json": JSON.stringify({ nodeId: "n-1" }) }, out);
  const code = await runDiagnose(d);
  assert.equal(code, 0);
  assert.ok(d.written["/out/bundle.json"], "the bundle was not written");

  const said = out.join("\n");
  assert.match(said, /Nothing has been sent anywhere/);
  assert.match(said, /read it, and send it on only if you are happy to/);
});
