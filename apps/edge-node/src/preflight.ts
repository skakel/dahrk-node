/**
 * `dahrk run preflight` - the engine-backed twin of the instant local `dahrk doctor`, and the first
 * slice of a general `dahrk run <workflow>`. Where `doctor` is a flat one-pass host check, this runs
 * the *preflight workflow* as a sequence of stages against the node's worktree, streaming `[n/N] <stage>`
 * progress exactly as the same run streams into Linear from a hub-dispatched build - but fired from the
 * terminal with no Linear, no OAuth, and no issue. It answers one question: "is this floor sound enough
 * to run?" and its exit code reflects sound (0) / unsound (1).
 *
 * The central `preflight` workflow definition (DHK-328) and the Haiku `analyse` stage live in the
 * harness engine and stream from the hub. This repo is the edge - it has no local workflow engine - so
 * the CLI runs a self-contained sequencer of the same shape: deterministic check stages, then a plain-
 * English `analyse` read synthesised locally (no inference, so it runs offline in a few seconds), then a
 * `report` stage that renders the summary and the link to the full artifact at `app.dahrk.ai/r/<runId>`.
 *
 * Design invariants, mirrored from the epic:
 *  - Determinism boundary holds: stages are sequenced in pure TS; the local `analyse` is deterministic.
 *  - A check that cannot run is a *finding*, never a crash (a missing tool, an unreachable hub).
 *  - Only a genuinely unsound floor (old Node, not a git repo, git missing, worktree unwritable) fails.
 *
 * The stage/check builders are pure - they take already-gathered probe results and return a verdict -
 * so they unit-test without a host or a network; `runPreflight` is the thin IO shell that gathers the
 * inputs, streams the report, and returns the process exit code.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, readdirSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HubProbeResult } from "@dahrk/edge";
import { probeHub as realProbeHub } from "@dahrk/edge";
import { checkHub, checkNode, checkToken, type CheckResult } from "./doctor.js";
import { dim, out as uiOut, symbol } from "./ui.js";

/** The public web surface that renders a full run report; the CLI prints a deep link to it. */
export const REPORT_BASE_URL = "https://app.dahrk.ai/r";

/** Free-space floor below which we raise a finding (a workflow clones a repo and writes a worktree). */
const LOW_DISK_BYTES = 512 * 1024 * 1024; // 512 MiB

/** The ordered stages of the preflight workflow, matching the CLI-twin mock (`[1/5] check node …
 *  [5/5] report`). The three `check-*` stages each aggregate several deterministic sub-checks; `analyse`
 *  turns the findings into a plain-English read; `report` renders the artifact link. */
export const PREFLIGHT_STAGES = [
  { id: "check-node", label: "check node" },
  { id: "check-repo", label: "check repo" },
  { id: "check-tools", label: "check tools" },
  { id: "analyse", label: "analyse" },
  { id: "report", label: "report" },
] as const;

/** A resolved git worktree's shape, gathered once and handed to the pure `checkRepo`. */
export interface RepoProbe {
  path: string;
  isGitRepo: boolean;
  /** The branch HEAD currently resolves to (the run's base), when the repo has commits. */
  baseBranch?: string;
  /** HEAD resolves to a commit (a fresh `git init` with no commits does not). */
  headResolves: boolean;
  /** The `origin` remote URL, when the repo has one. This is what `dahrk repo add` registers with the
   *  hub - read here because the node already sits next to the code, so no URL need ever be pasted.
   *  Best-effort: a repo with no `origin` leaves it undefined. */
  remoteUrl?: string;
  /** Why the path is not a usable git repo, for the finding text. */
  detail?: string;
}

/** Which host tools are present. Absence of anything but `git` is a finding, not a floor failure. */
export interface ToolPresence {
  git: boolean;
  /** An SSH key the agent can push with (a key file or a loaded agent identity). */
  sshKey: boolean;
  /** The Claude runtime CLI is on PATH (authenticated login is not probed here). */
  claude: boolean;
  /** `gh` is installed (ambient GitHub auth for PR opening). */
  gh: boolean;
  docker: boolean;
}

/** Host facts the check stages read, gathered by the IO shell (injectable so the sequencer unit-tests
 *  without touching the real host). */
export interface HostFacts {
  /** Worktree root the node clones into is writable (`~/.dahrk/worktrees` or its override). */
  worktreeRootWritable: boolean;
  /** Free bytes on the volume backing the worktree root; undefined when it could not be read. */
  freeDiskBytes?: number;
  tools: ToolPresence;
  repo: RepoProbe;
}

// -- pure sub-checks (host node group) ---------------------------------------

/** The client/worktree floor beyond the Node-version check: is the clone target writable, and is there
 *  enough free space to clone a repo and build a worktree? Unwritable is a hard floor failure. */
export function checkWorktreeRoot(writable: boolean): CheckResult {
  return writable
    ? { status: "pass", label: "Worktree root", detail: "writable" }
    : { status: "fail", label: "Worktree root", detail: "not writable; the node cannot create worktrees here" };
}

export function checkDiskSpace(freeBytes: number | undefined): CheckResult {
  if (freeBytes === undefined) {
    return { status: "warn", label: "Free space", detail: "could not be determined" };
  }
  const gib = (freeBytes / (1024 * 1024 * 1024)).toFixed(1);
  return freeBytes >= LOW_DISK_BYTES
    ? { status: "pass", label: "Free space", detail: `${gib} GiB` }
    : { status: "warn", label: "Free space", detail: `only ${gib} GiB free; a clone + worktree may not fit` };
}

// -- pure sub-checks (repo group) --------------------------------------------

/** The repo floor: the target path must be a git repo the node can build a worktree from. Not a git
 *  repo is a hard failure (there is nothing to run a workflow against); an empty repo with no commits
 *  is a finding (the base branch does not yet resolve). */
export function checkRepo(repo: RepoProbe): CheckResult {
  if (!repo.isGitRepo) {
    return {
      status: "fail",
      label: "Repository",
      detail: `${repo.path} is not a git repository${repo.detail ? ` (${repo.detail})` : ""}`,
    };
  }
  if (!repo.headResolves) {
    return { status: "warn", label: "Repository", detail: `${repo.path}: no commits yet (base branch does not resolve)` };
  }
  return { status: "pass", label: "Repository", detail: `${repo.path} on ${repo.baseBranch ?? "(detached)"}` };
}

// -- pure sub-checks (tools group) -------------------------------------------

/** The tool floor. `git` is required (a worktree run cannot happen without it) so its absence fails;
 *  every other tool is a graceful-degradation finding (no ssh key / no claude / no gh / no docker). */
export function checkTools(tools: ToolPresence): CheckResult[] {
  const git: CheckResult = tools.git
    ? { status: "pass", label: "git", detail: "installed" }
    : { status: "fail", label: "git", detail: "not found; git is required to run a workflow" };
  const finding = (present: boolean, label: string, missing: string): CheckResult =>
    present
      ? { status: "pass", label, detail: "available" }
      : { status: "warn", label, detail: missing };
  return [
    git,
    finding(tools.sshKey, "SSH key", "no key or agent identity found; pushing over SSH will fail"),
    finding(tools.claude, "Claude runtime", "not on PATH; the node will serve no agent stages"),
    finding(tools.gh, "gh CLI", "not installed; ambient PR opening is unavailable"),
    finding(tools.docker, "docker", "not present; container stages are unavailable"),
  ];
}

// -- analyse (deterministic plain-English read) ------------------------------

/** Downgrade a hub/token check to a finding: a terminal preflight is issue-less and offline-capable, so
 *  an unreachable hub must never make the *floor* unsound - it is an early warning, not a failure. */
function asFinding(check: CheckResult): CheckResult {
  return check.status === "fail" ? { ...check, status: "warn" } : check;
}

/** The `analyse` stage: turn the deterministic findings into the plain-English read the report leads
 *  with. The central workflow runs this on Haiku; the CLI twin synthesises it deterministically so the
 *  run needs no inference and no network. */
export function synthesise(checks: CheckResult[]): string {
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  const list = (cs: CheckResult[]): string => cs.map((c) => `${c.label.toLowerCase()} (${c.detail ?? "finding"})`).join("; ");
  if (fails.length > 0) {
    return `The floor is unsound: ${list(fails)}. Fix ${fails.length === 1 ? "this" : "these"} before running a workflow here.`;
  }
  if (warns.length > 0) {
    return `The floor is sound, with ${warns.length} early warning${warns.length === 1 ? "" : "s"}: ${list(warns)}. ${warns.length === 1 ? "It does" : "These do"} not block a run, but ${warns.length === 1 ? "is" : "are"} worth addressing.`;
  }
  return "The floor is sound. Node, repo, and tools all check out - this host is ready to run a workflow.";
}

// -- orchestration -----------------------------------------------------------

/** Injectable IO/probes so `runPreflight` runs without a host or a network in tests. */
export interface PreflightDeps {
  nodeVersion: string;
  probeHub: typeof realProbeHub;
  /** Gather the host facts (worktree root, disk, tools, repo) for the given repo path. */
  gatherHost: (repoPath: string) => Promise<HostFacts> | HostFacts;
  /** Mint the run id the report link is keyed by (default: a random UUID). */
  newRunId: () => string;
  out: (line: string) => void;
}

export interface PreflightInputs {
  /** The repo to inspect; defaults to the current working directory. */
  repoPath?: string;
  hubUrl?: string;
  token?: string;
  clientVersion?: string;
}

/** One stage's aggregated verdict, streamed as a `[n/N] <label>` line plus any finding bullets. */
export interface StageVerdict {
  label: string;
  status: CheckResult["status"];
  checks: CheckResult[];
}

/** Fold a group of sub-checks into a single stage status (fail beats warn beats pass). */
function worst(checks: CheckResult[]): CheckResult["status"] {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

/** Render one completed stage: a tick when clean, else the stage line followed by a bullet per finding
 *  (warn or fail). The glyphs come from the shared vocabulary, so a tick here means what it means in
 *  `status` and `doctor` rather than being this module's private invention. */
function renderStage(index: number, total: number, stage: StageVerdict, out: (l: string) => void): void {
  const head = `  ${dim(`[${index}/${total}]`)} ${stage.label}`;
  const findings = stage.checks.filter((c) => c.status !== "pass");
  if (findings.length === 0) {
    out(`${head} ${symbol("ok")}`);
    return;
  }
  out(head);
  for (const f of findings) {
    const level = f.status === "fail" ? "fail" : "warn";
    out(`      ${symbol(level)} ${f.label}: ${dim(f.detail ?? f.status)}`);
  }
}

/**
 * Run the preflight workflow locally: sequence the five stages against `repoPath`, stream `[n/N]`
 * progress, print the analyse read + summary + report link, and return the exit code (0 = sound floor,
 * 1 = unsound). No Linear, no OAuth, no issue - just the machine and the engine.
 */
export async function runPreflight(inputs: PreflightInputs, deps: Partial<PreflightDeps> = {}): Promise<number> {
  const d = { ...defaultDeps(), ...deps };
  const repoPath = inputs.repoPath ?? process.cwd();
  const total = PREFLIGHT_STAGES.length;
  const runId = d.newRunId();

  d.out("dahrk run preflight");
  d.out("");

  const host = await d.gatherHost(repoPath);

  // [1/5] check node - Node version, worktree root, free space, and hub reachability/latency. The hub
  // probe is optional (issue-less run) and clamped to a finding so an unreachable hub never fails the floor.
  const probe: HubProbeResult | undefined = inputs.hubUrl
    ? await d.probeHub({
        hubUrl: inputs.hubUrl,
        ...(inputs.token ? { enrolToken: inputs.token } : {}),
        runtimes: host.tools.claude ? ["claude-code"] : [],
        ...(inputs.clientVersion ? { clientVersion: inputs.clientVersion } : {}),
      })
    : undefined;
  const nodeChecks: CheckResult[] = [
    checkNode(d.nodeVersion),
    checkWorktreeRoot(host.worktreeRootWritable),
    checkDiskSpace(host.freeDiskBytes),
    asFinding(checkHub(inputs.hubUrl, probe)),
    ...(inputs.token ? [asFinding(checkToken(true, inputs.hubUrl, probe))] : []),
  ];

  // [2/5] check repo - the target is a git repo the node can build a worktree from.
  const repoChecks: CheckResult[] = [checkRepo(host.repo)];

  // [3/5] check tools - git (required) + ssh key / claude / gh / docker (findings).
  const toolChecks: CheckResult[] = checkTools(host.tools);

  const stageVerdicts: StageVerdict[] = [
    { label: PREFLIGHT_STAGES[0].label, status: worst(nodeChecks), checks: nodeChecks },
    { label: PREFLIGHT_STAGES[1].label, status: worst(repoChecks), checks: repoChecks },
    { label: PREFLIGHT_STAGES[2].label, status: worst(toolChecks), checks: toolChecks },
  ];
  stageVerdicts.forEach((v, i) => renderStage(i + 1, total, v, d.out));

  // [4/5] analyse - synthesise the deterministic findings into a plain-English read.
  const allChecks = [...nodeChecks, ...repoChecks, ...toolChecks];
  const read = synthesise(allChecks);
  renderStage(4, total, { label: PREFLIGHT_STAGES[3].label, status: "pass", checks: [] }, d.out);

  // [5/5] report - render the artifact link.
  renderStage(5, total, { label: PREFLIGHT_STAGES[4].label, status: "pass", checks: [] }, d.out);

  const failed = allChecks.filter((c) => c.status === "fail").length;
  const warned = allChecks.filter((c) => c.status === "warn").length;
  const summary =
    failed > 0
      ? `UNSOUND - ${failed} floor check${failed === 1 ? "" : "s"} failed${warned ? `, ${warned} finding${warned === 1 ? "" : "s"}` : ""}.`
      : warned > 0
        ? `SOUND with ${warned} finding${warned === 1 ? "" : "s"}.`
        : "SOUND - all checks green.";

  d.out("");
  d.out(read);
  d.out("");
  d.out(summary);
  d.out(`Full report: ${REPORT_BASE_URL}/${runId}`);
  d.out("");
  d.out("no Linear, no OAuth, no issue. just the machine and the engine.");

  return failed > 0 ? 1 : 0;
}

const defaultDeps = (): PreflightDeps => ({
  nodeVersion: process.versions.node,
  probeHub: realProbeHub,
  gatherHost: gatherHostFacts,
  newRunId: () => randomUUID(),
  out: uiOut,
});

// -- real host probes --------------------------------------------------------

/** True if `cmd` resolves on PATH (a light `command -v`, swallowing the non-zero exit for a miss). The
 *  shell builtin runs via `sh -c`; `cmd` is always one of our own literals, so there is nothing to
 *  escape. */
function commandPresent(cmd: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A pushable SSH identity exists: a `*.pub` under `~/.ssh`, or a key loaded in the running ssh-agent.
 *  Exported so `dahrk repo add` can make the SSH-vs-HTTPS choice from the same signal preflight uses. */
export function sshKeyPresent(): boolean {
  try {
    const dir = join(homedir(), ".ssh");
    if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".pub"))) return true;
  } catch {
    /* fall through to the agent probe */
  }
  try {
    execFileSync("ssh-add", ["-l"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Resolve a directory's writability by probing access (W_OK); a missing dir is not writable. */
function writable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The worktree root the node clones into: `DAHRK_WORKTREES_DIR` or `~/.dahrk/worktrees`. Its *parent*
 *  being writable is what matters (the node mkdirs the root on demand), so probe the nearest existing
 *  ancestor. */
function worktreeRoot(env: NodeJS.ProcessEnv): string {
  return env.DAHRK_WORKTREES_DIR ?? join(env.DAHRK_STATE_DIR ?? join(homedir(), ".dahrk"), "worktrees");
}

function nearestExisting(dir: string): string {
  let cur = dir;
  while (!existsSync(cur)) {
    const parent = join(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

function freeDiskBytes(dir: string): number | undefined {
  try {
    const s = statfsSync(nearestExisting(dir));
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}

/** Probe a git repo: is it a work tree, does HEAD resolve, to which branch, and what is its `origin`
 *  remote. Best-effort - any failure surfaces as `isGitRepo: false` with a detail, never a throw.
 *  Exported so `dahrk repo add` reuses the same cwd probe rather than growing a second `git -C` site. */
export function probeRepo(repoPath: string): RepoProbe {
  const git = (args: string[]): string =>
    execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") {
      return { path: repoPath, isGitRepo: false, headResolves: false, detail: "not inside a work tree" };
    }
  } catch {
    // git exits non-zero outside a repo (or is not installed); the "not a git repository" verdict is
    // already clear, so we do not surface the raw git error text.
    return { path: repoPath, isGitRepo: false, headResolves: false };
  }
  let headResolves = false;
  let baseBranch: string | undefined;
  try {
    git(["rev-parse", "--verify", "HEAD"]);
    headResolves = true;
    baseBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || undefined;
  } catch {
    /* a fresh repo with no commits: git repo, but HEAD does not resolve yet */
  }
  // The origin remote, when the repo has one. A repo with no `origin` (or a bare `git init`) exits
  // non-zero here; that is a finding for `repo add`, not a probe failure, so it stays undefined.
  let remoteUrl: string | undefined;
  try {
    remoteUrl = git(["remote", "get-url", "origin"]) || undefined;
  } catch {
    /* no origin remote configured */
  }
  return {
    path: repoPath,
    isGitRepo: true,
    headResolves,
    ...(baseBranch ? { baseBranch } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
  };
}

/** Gather all host facts for the preflight against `repoPath`. */
export function gatherHostFacts(repoPath: string): HostFacts {
  const root = worktreeRoot(process.env);
  return {
    worktreeRootWritable: writable(nearestExisting(root)),
    freeDiskBytes: freeDiskBytes(root),
    tools: {
      git: commandPresent("git"),
      sshKey: sshKeyPresent(),
      claude: commandPresent("claude"),
      gh: commandPresent("gh"),
      docker: commandPresent("docker"),
    },
    repo: probeRepo(repoPath),
  };
}
