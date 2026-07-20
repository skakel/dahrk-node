/**
 * The Pi RPC client: the second `PiSessionFactory` back-end for the Pi adapter.
 *
 * `PiRpcSession` drives a `pi --mode rpc` process (JSON-RPC over the process stdio) as a
 * `PiSessionLike`, so the T6 adapter's `runBatch`/`runInteractive`/`summarise`/`cancel`
 * orchestration runs unchanged against a containerised Pi. It takes an already-spawned child
 * (stdin writable + stdout readable) rather than spawning one, so this unit is testable against a
 * fixture subprocess and the container factory (Task 4) can hand it a `docker run -i` child.
 *
 * Protocol facts that shape this client (Pi coding-agent JSONL RPC):
 *   - Framing is strict LF-only JSONL. Split on `\n` only, strip a trailing `\r`. Node `readline`
 *     is NOT compliant (it also splits on U+2028/U+2029, valid inside JSON strings), so we use a
 *     byte-buffer decoder (`createLineDecoder`) instead.
 *   - `prompt` acks immediately (`{type:"response",command:"prompt",success:true}` means accepted,
 *     not done); the run finishes later at the `agent_end` event. The embedded `session.prompt()`
 *     resolves when the agent run finishes, so the RPC `prompt()` resolves on `agent_end` too:
 *     the event is delivered to subscribers FIRST (settling the mapper buffer), then the pending
 *     `prompt()` promise resolves.
 *   - Events on stdout match the mapper's `PiEvent` shape. Each parsed line is validated at the wire
 *     boundary by `parsePiEvent` (the stdout is untrusted subprocess output) and forwarded to
 *     subscribers with no re-mapping; the adapter maps them via `consumePiEvent`.
 *   - `abort` -> `{type:"abort"}` resolves on its command ack; `get_state` returns
 *     `data.sessionId`, a best-effort resume token.
 *
 * Degradation (Open Question 1): the RPC session has no `agent` handle, so `summarise`'s
 * tool-denial (which mutates `s.agent.state.tools`) is a no-op here. Accepted for the first cut
 * (meta-loop stages are telemetry-only); `agent` is intentionally omitted from this class.
 */
import { StringDecoder } from "node:string_decoder";
import { parsePiEvent, type PiEvent } from "./pi-mappers.js";
import type { PiSessionLike } from "./pi-adapter.js";

/**
 * A strict LF-only JSONL splitter. `push` accepts a chunk (Buffer or string) and returns the
 * complete records it completes; `end` flushes any trailing record. Uses `StringDecoder` so a
 * multi-byte UTF-8 sequence split across chunks (e.g. the 3 bytes of U+2028) is buffered until
 * complete. Records are split on `\n` only; a trailing `\r` is stripped. This is the reader the
 * RPC docs mandate in place of Node `readline`.
 */
export function createLineDecoder(): {
  push(chunk: Buffer | string): string[];
  end(): string[];
} {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const drain = (): string[] => {
    const lines: string[] = [];
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines.push(line);
    }
    return lines;
  };
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      return drain();
    },
    end() {
      buffer += decoder.end();
      const lines = drain();
      if (buffer.length > 0) {
        const last = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        buffer = "";
        lines.push(last);
      }
      return lines;
    },
  };
}

/** The minimal child-process shape `PiRpcSession` drives: LF-framed JSON in, JSONL out. */
export interface PiRpcChild {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
}

export interface PiRpcSessionOptions {
  /**
   * Called exactly once on `dispose()` to tear down the underlying transport (e.g. `docker kill`).
   * `PiRpcSession` guarantees idempotency, so the callback need not guard against a second call.
   */
  kill?: () => void | Promise<void>;
}

/** A Pi RPC command response frame (`{type:"response", ...}`). */
interface PiRpcResponse {
  type: "response";
  command?: string;
  id?: string;
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(err: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const isResponse = (msg: unknown): msg is PiRpcResponse =>
  typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "response";

export class PiRpcSession implements PiSessionLike {
  #sessionId: string | undefined;
  #listeners: Array<(ev: PiEvent) => void> = [];
  /** Command responses awaited by id (correlated via the optional `id` field). */
  #pendingResponses = new Map<string, Deferred<PiRpcResponse>>();
  /** The in-flight `prompt()` resolver, settled on the next `agent_end`. */
  #pendingAgentEnd: Deferred<void> | undefined;
  #reqCounter = 0;
  #disposed = false;
  readonly #child: PiRpcChild;
  #kill: (() => void | Promise<void>) | undefined;

  constructor(child: PiRpcChild, options: PiRpcSessionOptions = {}) {
    this.#child = child;
    this.#kill = options.kill;
    const decoder = createLineDecoder();
    const onData = (chunk: Buffer | string): void => {
      for (const line of decoder.push(chunk)) if (line.length > 0) this.#onLine(line);
    };
    child.stdout?.on("data", onData);
    child.stdout?.on("end", () => {
      for (const line of decoder.end()) if (line.length > 0) this.#onLine(line);
    });
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  subscribe(listener: (ev: PiEvent) => void): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  }

  async prompt(text: string): Promise<void> {
    if (this.#disposed) throw new Error("pi rpc session disposed");
    const agentEnd = deferred<void>();
    this.#pendingAgentEnd = agentEnd;
    const ack = await this.#send("prompt", { message: text });
    if (ack.success === false) {
      this.#pendingAgentEnd = undefined;
      throw new Error(ack.error ?? "prompt rejected");
    }
    await agentEnd.promise;
  }

  async abort(): Promise<void> {
    if (this.#disposed) return;
    await this.#send("abort", {});
  }

  /** Best-effort refresh of the resume token from `get_state`; swallows a failed lookup. */
  async getState(): Promise<void> {
    if (this.#disposed) return;
    try {
      const res = await this.#send("get_state", {});
      const id = res.data?.sessionId;
      if (typeof id === "string" && id) this.#sessionId = id;
    } catch {
      /* best effort: the resume token is optional */
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#child.stdin?.end();
    } catch {
      /* stream may already be closed */
    }
    const err = new Error("pi rpc session disposed");
    for (const d of this.#pendingResponses.values()) d.reject(err);
    this.#pendingResponses.clear();
    if (this.#pendingAgentEnd) {
      this.#pendingAgentEnd.reject(err);
      this.#pendingAgentEnd = undefined;
    }
    if (this.#kill) {
      const kill = this.#kill;
      this.#kill = undefined;
      void kill();
    }
  }

  /** Write a command as one LF-terminated JSON line and await its correlated response. */
  #send(type: string, fields: Record<string, unknown>): Promise<PiRpcResponse> {
    const id = `req-${++this.#reqCounter}`;
    const d = deferred<PiRpcResponse>();
    this.#pendingResponses.set(id, d);
    try {
      this.#child.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    } catch (e) {
      this.#pendingResponses.delete(id);
      d.reject(e as Error);
    }
    return d.promise;
  }

  #onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore an unparseable line rather than crash the reader
    }
    if (isResponse(msg)) {
      const id = msg.id;
      if (typeof id === "string") {
        const pending = this.#pendingResponses.get(id);
        if (pending) {
          this.#pendingResponses.delete(id);
          pending.resolve(msg);
        }
      }
      return;
    }
    // Anything that is not a command response should be an agent event. Validate it at this boundary
    // (the wire is untrusted subprocess stdout) rather than casting straight to `PiEvent`: a `null`, a
    // primitive, or a malformed `message_update` would otherwise crash the mapper on first field access.
    const ev = parsePiEvent(msg);
    if (!ev) return; // not a command response and not a well-formed agent event: drop it
    for (const l of [...this.#listeners]) l(ev);
    // Deliver-then-resolve: the buffer settles on agent_end before the prompt promise resolves.
    if (ev.type === "agent_end" && this.#pendingAgentEnd) {
      const d = this.#pendingAgentEnd;
      this.#pendingAgentEnd = undefined;
      d.resolve();
    }
  }
}
