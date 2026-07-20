/**
 * Tests for the Pi RPC client. `PiRpcSession` drives a `pi --mode rpc`
 * subprocess as a `PiSessionLike`, so the T6 adapter orchestration runs unchanged against a
 * container back-end. Two levels: (1) the strict LF-only JSONL decoder is unit-tested against
 * multi-chunk splits and a JSON string containing U+2028 (the `readline` pitfall rpc.md warns
 * about); (2) the session is driven against a fixture `fake-pi-rpc.mjs` subprocess with no
 * Docker and no live inference.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiEvent } from "../src/pi-mappers.js";
import { PiRpcSession, createLineDecoder } from "../src/pi-rpc-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(here, "fixtures", "fake-pi-rpc.mjs");

test("createLineDecoder: splits on LF only, strips trailing CR, reassembles multi-chunk records", () => {
  const dec = createLineDecoder();
  // A record delivered across two chunks; a CRLF-terminated record; a trailing partial.
  assert.deepEqual(dec.push('{"a":'), []);
  assert.deepEqual(dec.push('1}\n{"b":2}\r\n{"c'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(dec.push('":3}\n'), ['{"c":3}']);
  assert.deepEqual(dec.end(), []);
});

test("createLineDecoder: a U+2028 inside a JSON string is NOT a record boundary", () => {
  const dec = createLineDecoder();
  // U+2028 (\u2028) and U+2029 live inside the string; only \n terminates a record.
  const record = '{"delta":"a\u2028b\u2029c"}';
  // Split the chunk mid-record and mid-multibyte to prove the decoder buffers correctly.
  const bytes = Buffer.from(record + "\n", "utf8");
  const cut = bytes.indexOf(0xa8); // middle of the U+2028 byte sequence (e2 80 a8)
  const lines = [...dec.push(bytes.subarray(0, cut)), ...dec.push(bytes.subarray(cut))];
  assert.equal(lines.length, 1, "exactly one record despite the embedded separators");
  assert.equal(JSON.parse(lines[0]!).delta, "a\u2028b\u2029c");
});

test("prompt() resolves only after agent_end; subscribers receive events in order", async () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  const stderr: string[] = [];
  child.stderr.on("data", (c) => stderr.push(c.toString()));
  const session = new PiRpcSession(child, {});
  const order: string[] = [];
  session.subscribe((ev) => order.push(`ev:${ev.type}`));

  await session.prompt("hi");
  order.push("resolved");

  const types = order.filter((o) => o.startsWith("ev:"));
  assert.deepEqual(types, [
    "ev:agent_start",
    "ev:turn_start",
    "ev:message_update",
    "ev:tool_execution_start",
    "ev:tool_execution_end",
    "ev:message_update",
    "ev:turn_end",
    "ev:agent_end",
  ]);
  assert.ok(order.indexOf("ev:agent_end") < order.indexOf("resolved"), "agent_end delivered before prompt resolves");
  assert.equal(order[order.length - 1], "resolved");

  const sent = stderr.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(sent.some((c) => c.type === "prompt" && c.message === "hi"), "sent the prompt command");

  session.dispose();
  await once(child, "exit");
});

test("subscribed events preserve a U+2028 inside a text delta over the subprocess stdio", async () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  const session = new PiRpcSession(child, {});
  const deltas: string[] = [];
  session.subscribe((ev) => {
    if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
      deltas.push(String(ev.assistantMessageEvent.delta ?? ""));
    }
  });
  await session.prompt("hi");
  assert.ok(deltas.some((d) => d.includes("\u2028")), "U+2028 survived framing intact");
  session.dispose();
  await once(child, "exit");
});

test("getState() populates sessionId best-effort from the get_state response", async () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  const session = new PiRpcSession(child, {});
  assert.equal(session.sessionId, undefined);
  await session.getState();
  assert.equal(session.sessionId, "pi-rpc-sess-1");
  session.dispose();
  await once(child, "exit");
});

test("abort() sends {type:'abort'} and resolves on the ack", async () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  const stderr: string[] = [];
  child.stderr.on("data", (c) => stderr.push(c.toString()));
  const session = new PiRpcSession(child, {});
  await session.abort();
  const sent = stderr.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(sent.some((c) => c.type === "abort"), "sent the abort command");
  session.dispose();
  await once(child, "exit");
});

test("dispose() closes stdin and fires the kill callback exactly once (idempotent)", async () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  let kills = 0;
  const session = new PiRpcSession(child, { kill: () => void kills++ });
  session.dispose();
  session.dispose();
  assert.equal(kills, 1, "kill callback fired exactly once");
  await once(child, "exit"); // stdin closed -> fixture exits
});

// Guard against the PiSessionLike shape drifting: the adapter drives exactly these members.
test("PiRpcSession satisfies the PiSessionLike contract the adapter drives", () => {
  const child = spawn(process.execPath, [FAKE_PI], { stdio: ["pipe", "pipe", "pipe"] });
  const session: import("../src/pi-adapter.js").PiSessionLike = new PiRpcSession(child, {});
  assert.equal(typeof session.subscribe, "function");
  assert.equal(typeof session.prompt, "function");
  assert.equal(typeof session.abort, "function");
  assert.equal(typeof session.dispose, "function");
  session.dispose();
});

test("PiRpcSession: malformed stdout lines are dropped at the wire boundary - never forwarded, never crash the reader", async () => {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const session = new PiRpcSession({ stdin, stdout }, {});
  const received: PiEvent[] = [];
  session.subscribe((ev) => received.push(ev));

  // Each line is valid JSON but not a well-formed event: a null (JSON null crashed the old `msg as
  // PiEvent` cast on `ev.type`), a primitive, an array, a typeless object, and a bodyless
  // message_update (whose `ame.type` access would throw). None must reach the subscriber or throw
  // inside the stdout 'data' handler.
  for (const line of ["null", "42", '"agent_end"', '[{"type":"agent_end"}]', '{"foo":1}', '{"type":"message_update"}']) {
    stdout.write(`${line}\n`);
  }
  // Command responses are still consumed (not events), and a well-formed event still flows through.
  stdout.write('{"type":"response","command":"noop","success":true}\n');
  stdout.write('{"type":"turn_start"}\n');
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(received.map((e) => e.type), ["turn_start"], "only the well-formed event reached the subscriber");
  session.dispose();
});
