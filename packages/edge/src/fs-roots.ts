/**
 * The filesystem a stage may touch (DHK-392).
 *
 * A stage agent runs with the node process's full privileges: `cwd` is where it starts, not a wall
 * it cannot climb. An agent looking for a package ran a `find /` across the whole filesystem and
 * scanned the operator's entire machine, network volumes included. Nothing stopped it: `shell_guard`
 * is a blocklist of seven dangerous commands, `write_scope` looks only at the worktree's git branch,
 * and the read tools were governed by nothing at all.
 *
 * So the node computes, per Job, the roots a stage is confined to. This is a node-side DEFAULT, not
 * a policy a workflow opts into: a run always has a worktree, and a stage that needs the rest of the
 * disk is a bug, not a use case. `shell-scan.ts` decides whether a shell command's paths sit inside
 * these roots; `builtins.ts` turns that into a deny.
 *
 * A future `fs_scope` policy widens a run's reach by appending to `rw`/`ro` - the shape is already
 * here, and nothing else has to change.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The roots a stage may touch, and where a relative path resolves from. */
export interface FsRoots {
  /** Read and write: the worktree, its scratch dir, the git object store it depends on, tmp. */
  rw: string[];
  /** Read only: the toolchain and config a stage legitimately reads (node, git, pnpm, ~/.gitconfig). */
  ro: string[];
  /** Denied outright, over `rw` and `ro`: credentials, keychains, mounted volumes. */
  deny: string[];
  /** Where a relative path resolves from - the worktree. */
  cwd: string;
}

/** Whether `target` is `root` or sits underneath it. The containment primitive shared with the stage
 *  runner's artifact resolution (which rejects the root itself; confinement must allow it). */
export function isUnder(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Expand `~` / `$HOME` and resolve a token against the worktree, so a relative path is judged
 *  exactly as the shell would resolve it. */
export function expandPath(raw: string, cwd: string): string {
  const home = homedir();
  const expanded = raw
    .replace(/^~(?=$|\/)/, home)
    .replace(/^\$\{HOME\}(?=$|\/)/, home)
    .replace(/^\$HOME(?=$|\/)/, home);
  return resolve(cwd, expanded);
}

/** The path with its deepest EXISTING ancestor realpath'd, so macOS's `/tmp` -> `/private/tmp` symlink
 *  does not read as an escape - and so a path that does not exist yet (a file about to be written)
 *  still resolves. */
export function realish(p: string): string {
  let head = p;
  const tail: string[] = [];
  while (head !== dirname(head)) {
    if (existsSync(head)) {
      try {
        return join(realpathSync.native(head), ...tail.reverse());
      } catch {
        return p;
      }
    }
    tail.push(head.slice(dirname(head).length + 1));
    head = dirname(head);
  }
  return p;
}

/** What a tool wants to do with a path. The read/write split is what gives `ro` teeth: a stage may
 *  read `~/.gitconfig` and the node install, and may write neither. */
export type Access = "read" | "write";

/** Whether a path is inside the roots for this access. `deny` beats everything; `rw` grants both;
 *  `ro` grants reads only. Both the literal and the realpath'd form are tested, so neither a symlink
 *  into the worktree nor one out of it is judged on its spelling alone. */
export function withinRoots(raw: string, roots: FsRoots, need: Access): boolean {
  const literal = expandPath(raw, roots.cwd);
  const real = realish(literal);
  const hits = (list: string[]) => list.some((root) => isUnder(root, literal) || isUnder(root, real));
  if (hits(roots.deny)) return false;
  if (hits(roots.rw)) return true;
  return need === "read" && hits(roots.ro);
}

/** The git object store a linked worktree actually lives in. A run's worktree `.git` is a FILE
 *  pointing at `<mirror>/worktrees/<runId>`: the index, refs and objects are all in the mirror, so a
 *  stage that cannot write there cannot run a single git command. Non-negotiable, and read+write. */
function gitCommonDir(worktreePath: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Where pnpm hard-links packages from. `pnpm install` WRITES here, so it is not a read-only path.
 *  Memoised: it is a property of the machine, not the run, and shelling out per Job is pure waste. */
let pnpmStoreCache: { path: string | undefined } | undefined;
function pnpmStore(): string | undefined {
  if (pnpmStoreCache) return pnpmStoreCache.path;
  try {
    const out = execFileSync("pnpm", ["store", "path"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 })
      .toString()
      .trim();
    pnpmStoreCache = { path: out || undefined };
  } catch {
    pnpmStoreCache = { path: undefined };
  }
  return pnpmStoreCache.path;
}

const splitRoots = (v: string | undefined): string[] =>
  (v ?? "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The roots for one Job. `worktreePath` is the stage's worktree (or, for a telemetry-only run with no
 * repo, its scratch dir - confinement still applies, it is just a smaller box).
 *
 * `DAHRK_FS_EXTRA_ROOTS` / `DAHRK_FS_EXTRA_READ_ROOTS` (colon-separated) widen the box without a
 * release. This guard is a heuristic that fails CLOSED on machines we cannot hot-patch, so an
 * operator whose legitimate toolchain lives somewhere we did not think of must be able to say so.
 */
export function computeFsRoots(opts: { worktreePath: string; scratchPath?: string }): FsRoots {
  const home = homedir();
  const wt = realish(resolve(opts.worktreePath));

  const rw = [
    wt,
    ...(opts.scratchPath ? [realish(resolve(opts.scratchPath))] : []),
    // Every git command in the worktree reads and writes here.
    ...[gitCommonDir(opts.worktreePath)].filter((p): p is string => Boolean(p)).map(realish),
    // Scratch space: `mkdtemp`, git's temp files, and an agent tidying a throwaway dir it created.
    ...[tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].map(realish),
    // The safe I/O sinks. `2>/dev/null` is on a third of the shell commands real stages run; treating
    // it as a write outside the worktree would deny most of a normal build. The raw devices are NOT
    // here, so `> /dev/sda` still fails confinement (as well as shell_guard's device-write regex).
    ...["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd"],
    ...[pnpmStore()].filter((p): p is string => Boolean(p)).map(realish),
    ...splitRoots(process.env.DAHRK_FS_EXTRA_ROOTS).map((p) => realish(resolve(p))),
  ];

  // The toolchain and its config. Without these, nothing runs: `node` is under /usr or /opt/homebrew,
  // and `git commit` without `~/.gitconfig` fails with "please tell me who you are".
  const ro = [
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/opt",
    "/nix",
    "/Library",
    "/System",
    "/proc",
    "/sys",
    join(home, ".gitconfig"),
    join(home, ".config"),
    join(home, ".npmrc"),
    join(home, ".cache"),
    join(home, "Library", "Caches"),
    join(home, "Library", "pnpm"),
    join(home, ".local", "share"),
    join(home, ".nvm"),
    join(home, ".volta"),
    join(home, ".asdf"),
    join(home, ".cargo"),
    join(home, ".rustup"),
    ...splitRoots(process.env.DAHRK_FS_EXTRA_READ_ROOTS).map((p) => realish(resolve(p))),
  ].map(realish);

  // Beats `ro`, so a credential under an otherwise-readable root stays unreadable. `/Volumes` is the
  // network-volume prompt from the report: an agent has no business on a mounted drive.
  const deny = [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "gcloud"),
    join(home, "Library", "Keychains"),
    "/Volumes",
    "/etc/shadow",
    "/etc/sudoers",
  ];

  return { rw, ro, deny, cwd: wt };
}
