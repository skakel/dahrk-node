/**
 * The Phase-1 governance builtins evaluated on the edge (build spec section 13): the
 * per-action `deny` guards write_scope, max_tool_calls, and shell_guard. They are pure
 * `PolicyRule`s built per Job from the composed workflow/stage policies the engine threads
 * down. cost_budget is engine-owned and never reaches here.
 *
 * The guards are deny-only ("yolo within guardrails"): they block, never pause to ask. Human
 * checkpoints live in the between-stage gates, not in a mid-stage policy ask.
 */
import { execFileSync } from "node:child_process";
import type { Policy } from "@dahrk/contracts";
import { withinRoots, type Access, type FsRoots } from "./fs-roots.js";
import type { PolicyRule } from "./policy.js";
import { scanCommand } from "./shell-scan.js";

/** Per-Job context the builtins close over (worktree + the run-scoped tool-call counter). */
export interface BuiltinContext {
  worktreePath: string;
  repoName: string;
  /** Run-scoped tool-call tally, shared across the run's stages (sticky on the edge). */
  runToolCalls: { count: number };
  /** The filesystem the stage is confined to (DHK-392). Absent only for an embedder that has no
   *  workspace at all; when present, confinement is ON - it is a node default, not a policy. */
  fsRoots?: FsRoots;
}

/**
 * Stage-level read-only lever. Unlike `shell_guard` (a dangerous-command blocklist that lets
 * benign-but-effectful shell through), this denies every write and shell tool outright, so a
 * stage's "read-only / safe by construction" intent is actually enforceable (e.g. Preflight).
 * The matching `@dahrk/contracts` schema addition is a companion change; recognised here so the
 * edge enforces the flag the moment the engine threads it through `job.policies`.
 */
export interface ReadOnlyPolicy {
  read_only: true;
}

/** A composed Job policy, plus the edge-local read-only lever pending its contracts schema. */
export type EdgePolicy = Policy | ReadOnlyPolicy;

const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
  "Bash",
  "command",
  "shell",
]);
const SHELL_TOOLS = new Set(["Bash", "command", "shell"]);
const DANGEROUS: RegExp[] = [
  /\bsudo\b/,
  /\bcurl\b[^\n|]*\|\s*sh\b/,
  />\s*\/dev\/(?!null|stdout|stderr|tty|fd\/)/, // write to a raw device, but allow the safe sinks (2>/dev/null etc.)
  /\bgit\s+push\b[^\n]*--force/,
  /\bchmod\s+777\b/,
  /\bmkfs\b/,
  /:\(\)\s*\{.*\};:/, // fork bomb
];

// A recursive `rm` is only catastrophic when it targets the filesystem root, the home directory,
// a top-level system directory, the current/parent directory, or a bare glob. Targeted removes
// (a named scratch dir, `node_modules`, `/tmp/foo`, or a `$VAR` the agent set itself) are the
// agent's normal way of cleaning up after itself and must be allowed - blanket-blocking every
// `rm -r` meant an agent literally could not tidy a throwaway dir it created during verification.
const CATASTROPHIC_RM_TARGET =
  /^(\/|~|\.|\.\.|\*|\$\{?HOME\}?|\/(usr|etc|var|bin|sbin|lib|lib64|opt|boot|root|home|users|system|library|private|dev|proc|sys|applications))$/i;

/** True only for a recursive `rm` aimed at a catastrophic literal target (see note above). */
function isDangerousRm(cmd: string): boolean {
  // Inspect each simple command separately so a safe `rm` next to other clauses is judged alone.
  for (const seg of cmd.split(/[\n;&|]+/)) {
    const m = seg.match(/\brm\b(.*)/s);
    if (!m) continue;
    const tokens = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
    const recursive = tokens.some((t) => t === "--recursive" || /^-[a-z]*r/i.test(t));
    if (!recursive) continue; // non-recursive rm is never in scope
    const targets = tokens.filter((t) => !t.startsWith("-"));
    if (targets.length === 0) return true; // `rm -rf` with no explicit target
    for (const raw of targets) {
      // Strip surrounding quotes and any trailing `/` or `/*` before matching the bare target.
      const t = raw.replace(/^['"]|['"]$/g, "").replace(/\/+\*?$/, "");
      if (t === "" || CATASTROPHIC_RM_TARGET.test(t)) return true;
    }
  }
  return false;
}

function currentBranch(worktreePath: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath }).toString().trim();
  } catch {
    return "";
  }
}

/** Match a value against simple `*` globs (e.g. "feature/*"). */
function globMatch(globs: string[], value: string): boolean {
  return globs.some((g) => {
    const re = new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return re.test(value);
  });
}

function commandOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return o.command;
  }
  return "";
}

/** The tools that name a path, and the input fields they name it in. Verified against
 *  `@anthropic-ai/claude-agent-sdk` (`sdk-tools.d.ts`): Read/Write/Edit carry `file_path`,
 *  NotebookEdit carries `notebook_path`, Glob/Grep carry `path`. Grep's `glob` is an rg `--glob`
 *  FILTER, not a root (`**\/*.ts` is not an escape), so it is deliberately not checked. Codex's
 *  `apply_patch` keys its `changes` record by path; Pi passes raw args. */
const PATH_FIELDS = ["file_path", "notebook_path", "path", "filePath", "cwd", "directory"];

/** Path-bearing tools that WRITE what they name; the rest read it. The split is what gives the
 *  read-only roots teeth: a stage may read `~/.gitconfig` and may not write it. */
const PATH_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

/** Every path an action names, from the shapes the three runtimes actually emit. */
function pathsIn(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const out: string[] = [];
  for (const f of PATH_FIELDS) {
    if (typeof o[f] === "string" && o[f]) out.push(o[f] as string);
  }
  // Codex's apply_patch: `{ changes: { "<path>": {...} } }` - the paths are the keys.
  if (o.changes && typeof o.changes === "object") {
    out.push(...Object.keys(o.changes as Record<string, unknown>));
  }
  return out;
}

/**
 * Confine the stage to the run's roots (DHK-392). Not a policy the workflow declares: a node-side
 * DEFAULT, on whenever the Job has a workspace, because an agent that reaches outside its worktree
 * is a bug rather than a use case. An agent hunting for a package ran `find /` and scanned the
 * operator's whole machine; this is what stops that, before the tool runs.
 *
 * On the Claude runtime this is a genuine pre-execution block (the adapter's `canUseTool` consults
 * it). Codex and Pi expose no such hook, so there it can only be caught after the fact - which the
 * stage runner escalates to a stage failure rather than a note nobody reads.
 *
 * `DAHRK_FS_CONFINE=0` disables it, and `DAHRK_FS_EXTRA_ROOTS` widens it: a fail-closed heuristic on
 * machines we cannot hot-patch needs a valve an operator can reach without waiting for a release.
 */
export function fsConfineRule(roots: FsRoots): PolicyRule {
  return {
    name: "fs_confine",
    evaluate(event) {
      if (event.kind !== "action") return null;

      const deny = (path: string, need: Access) => ({
        verdict: "deny" as const,
        policy: "fs_confine",
        reason: `${need === "write" ? "write to" : "read of"} "${path}" is outside the run's worktree`,
      });

      if (SHELL_TOOLS.has(event.tool)) {
        const result = scanCommand(commandOf(event.input), roots);
        if (result.kind === "escape") return deny(result.path, result.need);
        if (result.kind === "unparseable") {
          return {
            verdict: "deny",
            policy: "fs_confine",
            reason: `shell command could not be parsed for path confinement (${result.reason})`,
          };
        }
        return null;
      }

      const need: Access = PATH_WRITE_TOOLS.has(event.tool) ? "write" : "read";
      for (const p of pathsIn(event.input)) {
        if (!withinRoots(p, roots, need)) return deny(p, need);
      }
      return null;
    },
  };
}

/** Build the edge `PolicyRule`s for one Job from its composed (non-cost) policies. */
export function buildRules(policies: readonly EdgePolicy[], ctx: BuiltinContext): PolicyRule[] {
  const rules: PolicyRule[] = [];
  let stageToolCalls = 0;

  // First in the list, so the confinement verdict is the one the evaluator short-circuits on.
  if (ctx.fsRoots && process.env.DAHRK_FS_CONFINE !== "0") rules.push(fsConfineRule(ctx.fsRoots));

  for (const p of policies) {
    if ("read_only" in p && p.read_only) {
      // Deny-by-default for a read-only stage: block every write and shell tool outright
      // (WRITE_TOOLS already subsumes SHELL_TOOLS), so no command inspection is needed and
      // benign-but-effectful shell (curl POST, git push, `>` redirection) cannot leak. Read
      // tools (Read/Grep/Glob/…) stay allowed.
      rules.push({
        name: "read_only",
        evaluate(event) {
          if (event.kind !== "action" || !WRITE_TOOLS.has(event.tool)) return null;
          return { verdict: "deny", policy: "read_only", reason: `read-only stage: "${event.tool}" is not permitted` };
        },
      });
    } else if ("write_scope" in p) {
      const { branches, repos } = p.write_scope;
      rules.push({
        name: "write_scope",
        evaluate(event) {
          if (event.kind !== "action" || !WRITE_TOOLS.has(event.tool)) return null;
          if (repos && repos.length && !repos.includes(ctx.repoName)) {
            return { verdict: "deny", policy: "write_scope", reason: `repo "${ctx.repoName}" is out of write scope` };
          }
          if (branches && branches.length) {
            const b = currentBranch(ctx.worktreePath);
            if (!globMatch(branches, b)) {
              return {
                verdict: "deny",
                policy: "write_scope",
                reason: `branch "${b}" is out of write scope (${branches.join(", ")})`,
              };
            }
          }
          return null;
        },
      });
    } else if ("max_tool_calls" in p) {
      const { perStage, perRun } = p.max_tool_calls;
      rules.push({
        name: "max_tool_calls",
        evaluate(event) {
          if (event.kind !== "action") return null;
          stageToolCalls++;
          ctx.runToolCalls.count++;
          if (perStage !== undefined && stageToolCalls > perStage) {
            return { verdict: "deny", policy: "max_tool_calls", reason: `exceeded ${perStage} tool calls this stage` };
          }
          if (perRun !== undefined && ctx.runToolCalls.count > perRun) {
            return { verdict: "deny", policy: "max_tool_calls", reason: `exceeded ${perRun} tool calls this run` };
          }
          return null;
        },
      });
    } else if ("shell_guard" in p) {
      rules.push({
        name: "shell_guard",
        evaluate(event) {
          if (event.kind !== "action" || !SHELL_TOOLS.has(event.tool)) return null;
          const cmd = commandOf(event.input);
          if (isDangerousRm(cmd) || DANGEROUS.some((re) => re.test(cmd))) {
            return { verdict: "deny", policy: "shell_guard", reason: `shell command blocked: ${cmd.slice(0, 80)}` };
          }
          return null;
        },
      });
    }
    // cost_budget is engine-owned and is filtered out before threading; ignore if present.
  }
  return rules;
}
