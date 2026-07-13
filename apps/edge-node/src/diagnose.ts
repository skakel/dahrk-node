/**
 * `dahrk diagnose` - the support bundle.
 *
 * This is the honest answer to "how do I debug a node I cannot see?" when the node is on someone
 * else's machine. We do not, and will not, stream a customer's node logs to the hub: they carry file
 * paths, repo names, branch names, and agent error output. So instead of taking, we ask - and we make
 * asking cheap and safe:
 *
 *   1. the customer runs one command,
 *   2. it writes ONE file, locally,
 *   3. they can open it, read every byte, and decide,
 *   4. they send it if they want to.
 *
 * Nothing is uploaded. There is no flag to upload. That is the point: a bundle the customer has read is
 * one they can consent to, and consent you can point at later is worth more than telemetry you took.
 *
 * Everything in it is scrubbed on the way in (`scrubValue`) - the logs are already scrubbed at write
 * time, so this is belt and braces - and the enrolment token is dropped, never redacted-in-place, so
 * there is no shape of it left to attack.
 *
 * What goes in is deliberately bounded to what actually explains a failure: identity and versions, the
 * doctor's verdict, the tail of the structured log, and every crash record. What stays out: the
 * worktree, the repo, issue content, prompts, and agent traces (those already reach the hub through the
 * trace channel, where they are governed by the retention policy - see the harness's data-boundary doc).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrubValue } from "@dahrk/edge";
import { out as uiOut } from "./ui.js";
import type { NodeState } from "./state.js";

/** How much of the structured log to include. Enough to cover a boot, an enrolment and a run or two;
 *  small enough that a human can actually read the bundle before sending it, which is the whole design. */
export const BUNDLE_LOG_LINES = 2000;

/** The bundle. Plain JSON, not a zip: one file a human can open in any editor and read top to bottom.
 *  A zip would be smaller and completely opaque to the person being asked to consent to it. */
export interface Bundle {
  generatedAt: string;
  clientVersion: string;
  node: {
    /** From `~/.dahrk/node.json`, with `enrolToken` REMOVED (not redacted - removed). */
    state: Omit<NodeState, "enrolToken">;
    platform: string;
    arch: string;
    nodeVersion: string;
  };
  /** `dahrk doctor`'s output, so the bundle answers "was the host even sane?" without a second round trip. */
  doctor?: string[];
  /** The tail of node.jsonl, parsed. Already scrubbed at write time; scrubbed again here. */
  log: unknown[];
  /** Every crash record on the box. These are the first thing to read. */
  crashes: unknown[];
  /** Anything we could not collect, said out loud rather than silently omitted - an empty section in a
   *  support bundle is ambiguous ("no crashes" or "could not read crashes?"), and ambiguity wastes a round trip. */
  warnings: string[];
}

export interface DiagnoseDeps {
  stateFile: string;
  jsonlFile: string;
  crashDir: string;
  /** Where to write the bundle. */
  outFile: string;
  clientVersion: string;
  /** Run the doctor and return its lines. Omitted = skip that section. */
  doctor?: () => Promise<string[]>;
  readFile: (path: string) => string;
  listDir: (path: string) => string[];
  exists: (path: string) => boolean;
  writeFile: (path: string, content: string) => void;
  out: (line: string) => void;
}

/**
 * The last `n` RECORDS of a JSONL file - parse first, then take the tail.
 *
 * Order matters. Taking the last n raw lines and then parsing means a torn final line (normal: the node
 * may be mid-write while we read) eats one of the n, and at n=1 you get nothing at all. The caller asked
 * for n records, so give them n records.
 */
export function tailJsonl(raw: string, n: number): unknown[] {
  const records: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* torn or corrupt line; the rest of the log is still worth having */
    }
  }
  return n > 0 ? records.slice(-n) : records;
}

/** Build the bundle. Pure but for the injected IO, so it unit-tests without a filesystem. */
export async function buildBundle(deps: DiagnoseDeps): Promise<Bundle> {
  const warnings: string[] = [];

  // Identity, minus the secret. `enrolToken` is DELETED rather than replaced with a marker: a redaction
  // marker still tells you a token exists and how long it was.
  let state: Omit<NodeState, "enrolToken"> = {};
  if (deps.exists(deps.stateFile)) {
    try {
      const parsed = JSON.parse(deps.readFile(deps.stateFile)) as NodeState;
      const { enrolToken: _dropped, ...rest } = parsed;
      state = rest;
    } catch (e) {
      warnings.push(`could not read node state (${(e as Error).message})`);
    }
  } else {
    warnings.push("no node.json - this node has never enrolled");
  }

  let log: unknown[] = [];
  if (deps.exists(deps.jsonlFile)) {
    try {
      log = tailJsonl(deps.readFile(deps.jsonlFile), BUNDLE_LOG_LINES);
    } catch (e) {
      warnings.push(`could not read node.jsonl (${(e as Error).message})`);
    }
  } else {
    warnings.push("no node.jsonl - the node has not run since structured logging was added");
  }

  const crashes: unknown[] = [];
  if (deps.exists(deps.crashDir)) {
    for (const name of deps.listDir(deps.crashDir).filter((f) => f.endsWith(".json")).sort()) {
      try {
        crashes.push(JSON.parse(deps.readFile(join(deps.crashDir, name))));
      } catch (e) {
        warnings.push(`could not read crash record ${name} (${(e as Error).message})`);
      }
    }
  }

  let doctor: string[] | undefined;
  if (deps.doctor) {
    try {
      doctor = await deps.doctor();
    } catch (e) {
      warnings.push(`doctor failed (${(e as Error).message})`);
    }
  }

  const bundle: Bundle = {
    generatedAt: new Date().toISOString(),
    clientVersion: deps.clientVersion,
    node: {
      state,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },
    ...(doctor ? { doctor } : {}),
    log,
    crashes,
    warnings,
  };

  // Belt and braces. The logs were scrubbed when written and the token is already gone; this catches
  // anything a future contributor adds to the bundle without thinking about it.
  return scrubValue(bundle) as Bundle;
}

/**
 * Write the bundle and tell the operator what to do with it. Returns the exit code.
 *
 * The closing message matters as much as the file: it has to make "open it and look" the obvious next
 * step rather than a chore, or people will forward it unread, and a bundle forwarded unread is a bundle
 * nobody consented to.
 */
export async function runDiagnose(deps: DiagnoseDeps): Promise<number> {
  const bundle = await buildBundle(deps);
  try {
    deps.writeFile(deps.outFile, `${JSON.stringify(bundle, null, 2)}\n`);
  } catch (e) {
    deps.out(`Could not write the bundle: ${(e as Error).message}`);
    return 1;
  }

  deps.out(`Wrote a support bundle to ${deps.outFile}`);
  deps.out("");
  deps.out(`It contains: this node's id, name and tenant; its version and host; ${bundle.log.length} log`);
  deps.out(`lines; and ${bundle.crashes.length} crash record(s). Secrets are stripped and the enrolment`);
  deps.out("token is not in it. Your source code, prompts and issue content are not in it.");
  deps.out("");
  deps.out("Nothing has been sent anywhere. Open the file, read it, and send it on only if you are happy to.");
  if (bundle.warnings.length > 0) {
    deps.out("");
    deps.out("Note:");
    for (const w of bundle.warnings) deps.out(`  - ${w}`);
  }
  return 0;
}

export const defaultDiagnoseDeps = (
  paths: { stateFile: string; jsonlFile: string; crashDir: string; outFile: string },
  clientVersion: string,
  doctor?: () => Promise<string[]>,
): DiagnoseDeps => ({
  ...paths,
  clientVersion,
  ...(doctor ? { doctor } : {}),
  readFile: (p) => readFileSync(p, "utf8"),
  listDir: (p) => readdirSync(p),
  exists: (p) => existsSync(p),
  writeFile: (p, content) => {
    const dir = join(p, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 0600: it is not secret, but it is about this operator's machine and there is no reason for it to be
    // world-readable in a shared /tmp.
    writeFileSync(p, content, { mode: 0o600 });
  },
  out: uiOut,
});

/** Default bundle location: the current directory, timestamped. Deliberately NOT a temp dir - the operator
 *  has to be able to find it without being told a path they will have to copy-paste. */
export function defaultBundlePath(cwd: string, now: Date): string {
  return join(cwd, `dahrk-diagnose-${now.toISOString().replace(/[:.]/g, "-")}.json`);
}

/** Used by `statSync`-based callers to report the bundle size; kept here so `main` needs no fs import. */
export const bundleSize = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};
