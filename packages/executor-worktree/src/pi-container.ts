/**
 * The container Pi session factory: spawns `pi --mode rpc` inside
 * a Docker container and wraps the child in `PiRpcSession`, so the T6 adapter's orchestration
 * runs unchanged against a containerised Pi.
 *
 * Container lifecycle:
 *   - One container per stage job: the runner memoises the session, so `runBatch` + `summarise`
 *     share a single warm container. A new runner (new stage) spawns a new container.
 *   - Mount: `ctx.workspace.scratchPath` (telemetry + harness artefacts) appears inside the
 *     container at `/dahrk/scratch`. No customer worktree is mounted for meta-loop runs.
 *   - Inference env: `ctx.runtimeEnv` is injected as `-e KEY=VAL` pairs (never baked into the
 *     image), so provider keys and model overrides arrive at Pi without persisting credentials.
 *   - Teardown: `dispose()` -> `docker kill <containerName>`. `--rm` removes the container
 *     automatically on exit.
 *
 * Image: `DAHRK_PI_IMAGE` env var (default: `dahrk/pi:latest`). Override per-environment or
 * in tests via the `image` option.
 *
 * The `spawn` option is injected for tests (no Docker required); it defaults to the real
 * `node:child_process.spawn`.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { Runner, RunnerContext } from "@dahrk/contracts";
import { PiRpcSession } from "./pi-rpc-client.js";
import { createPiRunner } from "./pi-adapter.js";
import type { PiSessionFactory, PiSessionLike } from "./pi-adapter.js";

const DEFAULT_IMAGE = process.env.DAHRK_PI_IMAGE ?? process.env.SKAKEL_PI_IMAGE ?? "dahrk/pi:latest";

let _seq = 0;

export interface ContainerPiSessionOpts {
  /** Docker image containing `pi`. Default: `DAHRK_PI_IMAGE` env var or `dahrk/pi:latest`. */
  image?: string;
  /**
   * Host path to mount as `/dahrk/scratch` inside the container. Falls back to
   * `ctx.workspace.scratchPath` (set by the stage runner for every job). Pass explicitly
   * only when constructing the factory before a `RunnerContext` is available (e.g. tests).
   */
  scratchDir?: string;
  /** Injected for tests: replaces `node:child_process.spawn`. Default: the real spawn. */
  spawn?: typeof nodeSpawn;
  /**
   * Where the container's stderr goes. Default: `process.stderr`, prefixed.
   *
   * This is not merely a logging nicety. `stdio[2]` is a pipe, and nothing used to read it: a
   * container that wrote more than the ~64 KB pipe buffer would BLOCK on its next stderr write and
   * the session would hang, with the explanation sitting unread in the pipe. Draining it is what
   * makes that impossible - surfacing the message is the bonus.
   */
  onStderr?: (line: string) => void;
}

/**
 * Returns a `PiSessionFactory` that spawns `pi --mode rpc` inside a Docker container and
 * wraps it in a `PiRpcSession`. Pass to `createPiRunner({ createSession })` for isolation.
 */
export function createContainerPiSession(opts: ContainerPiSessionOpts = {}): PiSessionFactory {
  const {
    image = DEFAULT_IMAGE,
    scratchDir: optsScratchDir,
    spawn: spawnFn = nodeSpawn,
    onStderr = (line: string): void => void process.stderr.write(`pi-container: ${line}\n`),
  } = opts;

  return async (ctx: RunnerContext): Promise<PiSessionLike> => {
    const containerName = `dahrk-pi-${Date.now()}-${++_seq}`;
    const resolvedScratchDir = optsScratchDir ?? ctx.workspace.scratchPath;

    const mountArgs: string[] = resolvedScratchDir ? ["-v", `${resolvedScratchDir}:/dahrk/scratch`] : [];

    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(ctx.runtimeEnv ?? {})) {
      envArgs.push("-e", `${k}=${v}`);
    }

    const child = spawnFn(
      "docker",
      ["run", "-i", "--rm", "--name", containerName, ...mountArgs, ...envArgs, image, "pi", "--mode", "rpc"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    // Drain stderr line-by-line. Without this the pipe fills and the container blocks (see `onStderr`).
    child.stderr?.setEncoding("utf8");
    let stderrBuf = "";
    child.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() ?? ""; // keep the partial line for the next chunk
      for (const line of lines) if (line.trim()) onStderr(line);
    });
    child.stderr?.on("end", () => {
      if (stderrBuf.trim()) onStderr(stderrBuf);
      stderrBuf = "";
    });

    const killContainer = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const killer = spawnFn("docker", ["kill", containerName], { stdio: "ignore" } as Parameters<typeof nodeSpawn>[2]);
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
      });

    return new PiRpcSession(child, { kill: killContainer });
  };
}

/**
 * Convenience factory: a Pi runner that isolates each stage job in a fresh Docker container.
 * The container is torn down when the stage completes (via `cancel()` -> `dispose()`).
 *
 * Pass to `deps.makeRunner` on managed nodes where container isolation is required. For
 * the embedded non-isolated path, use `createPiRunner()` directly.
 */
export function createIsolatedPiRunner(opts: ContainerPiSessionOpts = {}): Runner {
  return createPiRunner({ createSession: createContainerPiSession(opts) });
}
