/**
 * Does this shell command reach outside the run's roots? (DHK-392)
 *
 * Deliberately NOT a shell parser. The insight that makes a heuristic sound here: a token can only
 * escape the worktree if it is ANCHORED outside it - it starts at `/`, at `~`/`$HOME`, or climbs out
 * with `..`. Every other operand (a bare name, a glob, a regex, a branch, a URL) resolves inside the
 * worktree by construction and needs no checking. So we look only at anchored tokens, and spend the
 * rest of the effort on not mistaking a PATTERN for a path - which is exactly what a
 * `find / -path <glob>` is made of: the root is the escape, the glob is innocent.
 *
 * Honest about what it is: a tool-argument guard, not a syscall sandbox. `X=/etc; cat $X/passwd`, or
 * a python script that opens a path never appearing in argv, still get through - the path is not in
 * the command. Closing those needs an OS sandbox (see the Claude adapter), and only on that runtime.
 */
import { expandPath, withinRoots, type Access, type FsRoots } from "./fs-roots.js";

export type ScanResult =
  | { kind: "ok" }
  | { kind: "escape"; path: string; need: Access }
  | { kind: "unparseable"; reason: string };

/** Flags whose operand is a PATTERN, never a path. Without this, a `find -path` glob and
 *  `rg -e '/api/v1' src/` would be denied for their pattern rather than their root. */
const PATTERN_FLAGS = new Set([
  "-e",
  "--regexp",
  "-path",
  "-ipath",
  "-name",
  "-iname",
  "-wholename",
  "--glob",
  "-g",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--type",
  "-m",
  "--message",
]);

/** Commands whose first non-flag operand is a pattern, not a path: `rg '/api/v1' src/`. */
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "perl"]);

/** Flags whose operand is ALWAYS a path, even relative: `git -C /Users/other/repo status`. */
const DIR_FLAGS = new Set(["-C", "--git-dir", "--work-tree", "--cwd", "--directory"]);

/** Commands that only ever print their arguments. `echo $HOME` is not a filesystem access. */
const NO_PATH_ARGV0 = new Set(["echo", "printf", ":", "true", "false"]);

/** Commands whose every path operand is written to. */
const WRITE_ALL = new Set(["rm", "rmdir", "mkdir", "touch", "chmod", "chown", "truncate", "mkfifo"]);

/** Commands whose LAST path operand is written to (the destination); earlier ones are read. */
const WRITE_LAST = new Set(["cp", "mv", "ln", "tee", "dd", "install", "rsync"]);

/** Shells that take a command as a string operand: recurse into it. */
const SHELL_ARGV0 = new Set(["sh", "bash", "zsh", "dash", "eval", "xargs", "env", "nohup", "time", "sudo"]);

const REDIRECTS = new Set([">", ">>", "<", "2>", "2>>", "&>", "<<<"]);

interface Token {
  value: string;
  /** Quoted tokens are still paths (`cat "/etc/hosts"`), but a quoted token carrying whitespace is
   *  prose (`git commit -m "/usr is broken"`), so the two facts are kept apart. */
  quoted: boolean;
  operator?: string;
}

/** Split a command into tokens, keeping control operators, and pulling out `$(...)`/backtick bodies
 *  for separate scanning. Returns null when the quoting is unbalanced. */
function tokenise(cmd: string): { tokens: Token[]; subshells: string[] } | null {
  const tokens: Token[] = [];
  const subshells: string[] = [];
  let cur = "";
  let quoted = false;
  let started = false;
  let quote: '"' | "'" | null = null;

  const push = () => {
    if (started) tokens.push({ value: cur, quoted });
    cur = "";
    quoted = false;
    started = false;
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string;

    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"' && i + 1 < cmd.length) {
        cur += cmd[++i];
        started = true;
      } else {
        cur += c;
        started = true;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      quoted = true;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      started = true;
      continue;
    }
    // `$(...)` and backticks: scan the inner command in its own right, and leave an opaque token
    // behind, so `cd $(git rev-parse --show-toplevel)` is not read as a path.
    if ((c === "$" && cmd[i + 1] === "(") || c === "`") {
      const open = c === "`" ? "`" : "(";
      const close = c === "`" ? "`" : ")";
      let depth = 1;
      let j = i + (c === "`" ? 1 : 2);
      let body = "";
      for (; j < cmd.length && depth > 0; j++) {
        const d = cmd[j] as string;
        if (d === open && close !== "`") depth++;
        else if (d === close) {
          depth--;
          if (depth === 0) break;
        }
        body += d;
      }
      if (depth > 0) return null; // unterminated substitution
      subshells.push(body);
      cur += "$SUBSHELL";
      started = true;
      i = j;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    // Control and redirection operators.
    const three = cmd.slice(i, i + 3);
    const two = cmd.slice(i, i + 2);
    if (three === "<<<") {
      push();
      tokens.push({ value: three, quoted: false, operator: three });
      i += 2;
      continue;
    }
    if (["&&", "||", ">>", "2>", "&>"].includes(two)) {
      push();
      tokens.push({ value: two, quoted: false, operator: two });
      i += 1;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === ">" || c === "<" || c === "\n") {
      push();
      tokens.push({ value: c, quoted: false, operator: c });
      continue;
    }
    cur += c;
    started = true;
  }
  if (quote) return null; // unbalanced quote
  push();
  return { tokens, subshells };
}

/** Anchored outside the cwd, or climbing out of it. Everything else resolves inside the worktree. */
function looksLikePath(t: Token): boolean {
  if (t.value.startsWith("-")) return false; // a flag: `-print0`, `--version`
  if (/\s/.test(t.value)) return false; // prose: `git commit -m "/usr is broken"`
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(t.value)) return false; // a URL, not a path
  const s = t.value.replace(/^@/, ""); // curl's `-d @file`
  if (s.includes("$SUBSHELL")) return false; // opaque: we scanned the inner command separately
  if (/^\$(?!\{?HOME\b)/.test(s)) return false; // `$T` is opaque - the shell knows, we do not
  return (
    /^(\/|~(?:$|\/)|\$\{?HOME\}?(?:$|\/)|\.\.(?:$|\/))/.test(s) || s.includes("/../") || s.endsWith("/..")
  );
}

const bare = (v: string) => v.replace(/^@/, "");

/** Scan one simple command (already split on control operators). `cwd` may be rebound by `cd`. */
function scanSimple(tokens: Token[], roots: FsRoots, cwd: string): ScanResult | { kind: "cd"; to: string } {
  const scoped: FsRoots = { ...roots, cwd };
  const check = (raw: string, need: Access): ScanResult | null =>
    withinRoots(bare(raw), scoped, need) ? null : { kind: "escape", path: bare(raw), need };

  const argv0 = tokens.find((t) => !t.operator && !t.value.includes("="))?.value ?? "";
  const cmdName = argv0.split("/").pop() ?? argv0;

  // A shell/wrapper invocation: recurse into the command it carries, rather than reading its script
  // as an operand. `sh -c 'find / -name x'` is the command it wraps.
  if (SHELL_ARGV0.has(cmdName)) {
    for (const t of tokens) {
      if (t.operator || t.value === argv0) continue;
      if (t.quoted || t.value.includes(" ")) {
        const inner = scanCommand(t.value, roots, cwd);
        if (inner.kind !== "ok") return inner;
      } else if (looksLikePath(t)) {
        const bad = check(t.value, "read");
        if (bad) return bad;
      }
    }
    return { kind: "ok" };
  }

  if (NO_PATH_ARGV0.has(cmdName)) {
    // Its arguments are printed, not opened. Redirections are handled by the caller.
    return { kind: "ok" };
  }

  const writeAll = WRITE_ALL.has(cmdName);
  const writeLast = WRITE_LAST.has(cmdName);
  const operands: Array<{ token: Token; index: number }> = [];
  let patternPending = PATTERN_FIRST.has(cmdName);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.operator) continue;
    if (t.value === argv0 && i === tokens.indexOf(t)) {
      if (looksLikePath(t)) {
        // An absolute argv0 (`/usr/bin/env`) is an execution, and `ro` covers the toolchain.
        const bad = check(t.value, "read");
        if (bad) return bad;
      }
      continue;
    }
    if (DIR_FLAGS.has(t.value)) {
      const operand = tokens[i + 1];
      if (operand && !operand.operator) {
        // Always a directory, even when relative: `git -C ../other-repo`.
        const bad = check(operand.value, "read");
        if (bad) return bad;
        i++;
      }
      continue;
    }
    if (PATTERN_FLAGS.has(t.value)) {
      i++; // its operand is a pattern, never a path
      continue;
    }
    if (t.value.startsWith("-")) continue;
    if (patternPending) {
      patternPending = false; // `rg '/api/v1' src/` - the first operand is the regex
      continue;
    }
    if (looksLikePath(t)) operands.push({ token: t, index: i });
  }

  // `cd <x>`: check it, then let the caller rebind cwd so `cd /tmp && rm -rf junk` still works.
  if (cmdName === "cd") {
    const target = tokens.find((t) => !t.operator && t.value !== argv0 && !t.value.startsWith("-"));
    if (!target) return { kind: "ok" };
    const bad = check(target.value, "read");
    if (bad) return bad;
    return { kind: "cd", to: target.value };
  }

  for (let n = 0; n < operands.length; n++) {
    const entry = operands[n] as { token: Token; index: number };
    const isLast = n === operands.length - 1;
    const need: Access = writeAll || (writeLast && isLast) ? "write" : "read";
    const bad = check(entry.token.value, need);
    if (bad) return bad;
  }
  return { kind: "ok" };
}

/**
 * Does `cmd` touch anything outside `roots`? `ok` when every anchored path it names is inside them.
 *
 * A command whose quoting cannot be parsed is `unparseable` and the caller denies it: it would fail
 * in the shell anyway, so refusing it costs nothing, and this guard must fail closed.
 */
export function scanCommand(cmd: string, roots: FsRoots, cwd: string = roots.cwd): ScanResult {
  if (!cmd.trim()) return { kind: "ok" };
  const lexed = tokenise(cmd);
  if (!lexed) return { kind: "unparseable", reason: "unbalanced quotes or unterminated substitution" };

  for (const body of lexed.subshells) {
    const inner = scanCommand(body, roots, cwd);
    if (inner.kind !== "ok") return inner;
  }

  let current: Token[] = [];
  let cwdNow = cwd;
  const segments: Token[][] = [];
  for (const t of lexed.tokens) {
    if (t.operator && [";", "|", "&", "&&", "||", "\n"].includes(t.operator)) {
      segments.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  segments.push(current);

  for (const seg of segments) {
    if (seg.length === 0) continue;

    // Redirection targets are written to (or read from) regardless of the command.
    const plain: Token[] = [];
    for (let i = 0; i < seg.length; i++) {
      const t = seg[i] as Token;
      if (t.operator && REDIRECTS.has(t.operator)) {
        const target = seg[i + 1];
        if (target && !target.operator) {
          const need: Access = t.operator === "<" || t.operator === "<<<" ? "read" : "write";
          if (!withinRoots(bare(target.value), { ...roots, cwd: cwdNow }, need)) {
            return { kind: "escape", path: bare(target.value), need };
          }
          i++;
        }
        continue;
      }
      plain.push(t);
    }

    const out = scanSimple(plain, roots, cwdNow);
    if (out.kind === "cd") {
      // Rebind through the same expansion the checks use, so the rest of the command is judged from
      // where the shell actually stands.
      cwdNow = expandPath(out.to, cwdNow);
      continue;
    }
    if (out.kind !== "ok") return out;
  }
  return { kind: "ok" };
}
