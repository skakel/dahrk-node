/**
 * Worktree confinement (DHK-392). An agent hunting for a package ran a `find /` and scanned the
 * operator's entire machine - every write and read tool was ungoverned by path. These pin the box:
 * what a stage may touch, what it may not, and - just as important - the ordinary commands a build
 * stage runs all day, which must not be mistaken for an escape.
 *
 * Real temp worktree, real roots (`computeFsRoots` shells out to git for the object store).
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildRules, type BuiltinContext } from "../src/builtins.js";
import { computeFsRoots } from "../src/fs-roots.js";
import { evaluatePolicies } from "../src/policy.js";

/**
 * The worktree is created under the HOME dir, not under tmp - deliberately. A real run's worktree is
 * `~/.dahrk/worktrees/<runId>`, and tmp is itself an allowed root, so a tmp-based fixture would make
 * `cd ..` a legal move and quietly stop testing the thing that matters.
 */
function worktree(): { path: string; scratch: string } {
  const path = mkdtempSync(join(homedir(), ".dahrk-confine-test-"));
  execFileSync("git", ["init", "-q"], { cwd: path });
  const scratch = join(path, ".skakel", "scratch");
  mkdirSync(scratch, { recursive: true });
  return { path, scratch };
}

const { path: WT, scratch: SCRATCH } = worktree();
after(() => rmSync(WT, { recursive: true, force: true }));

const ctx = (): BuiltinContext => ({
  worktreePath: WT,
  repoName: "dahrk-node",
  runToolCalls: { count: 0 },
  fsRoots: computeFsRoots({ worktreePath: WT, scratchPath: SCRATCH }),
});

const rules = () => buildRules([], ctx());
const verdict = (tool: string, input: unknown) =>
  evaluatePolicies({ kind: "action", stageId: "build", tool, input }, rules());
const sh = (command: string) => verdict("Bash", { command });

test("the regression: a whole-filesystem scan is denied before it runs", () => {
  const out = sh("find / -path '*/@dahrk/contracts/*job*'");
  assert.equal(out.verdict, "deny");
  assert.equal(out.policy, "fs_confine");
  assert.match(out.reason ?? "", /outside the run's worktree/);
});

test("shell commands that reach outside the worktree are denied", () => {
  for (const cmd of [
    "ls /",
    "ls /Volumes",
    "find ~ -name '*.pem'",
    "cat ~/.ssh/id_ed25519",
    "cat /Users/someone-else/notes.md",
    "grep -r password /Users",
    "git -C /Users/other/repo status",
    "cd .. && ls",
    "cat ../../etc/passwd",
    "sh -c 'find / -name x'",
    "echo pwned > /etc/foo",
    "cp secrets.env ~/Desktop/secrets.env",
  ]) {
    const out = sh(cmd);
    assert.equal(out.verdict, "deny", `expected deny: ${cmd}`);
    assert.equal(out.policy, "fs_confine", cmd);
  }
});

test("the ordinary commands a build stage runs are NOT mistaken for escapes", () => {
  for (const cmd of [
    "pnpm test",
    "pnpm install",
    "pnpm -r build",
    "git status",
    'git commit -m "fix: a thing"',
    "git push origin HEAD",
    'git commit -m "note: /usr/local was the problem"', // a path inside PROSE
    "node --version",
    "rg foo src/",
    "rg -e '/api/v1' src/", // the pattern is a path-shaped regex
    "grep -r TODO packages/",
    "find . -name '*.ts' -print0", // the flag operand is a glob, not a root
    "find . -type f -newer package.json",
    "sed -n '/^\\/usr/p' file.txt",
    "cat package.json",
    "ls node_modules/@dahrk/contracts",
    "rm -rf node_modules",
    "curl -s https://registry.npmjs.org/@dahrk/contracts", // a URL is not a path
    "echo $HOME",
    'test -f "$SOME_VAR"', // opaque variable: the shell knows, we do not
    "cd packages/edge && pnpm test",
    "git rev-parse --show-toplevel",
    "cd $(git rev-parse --show-toplevel) && pnpm build", // substitution scanned, not read as a path
    // The safe sinks. `2>/dev/null` appears on roughly a third of the shell commands real stages run
    // (measured against the Bash calls in three production run traces); reading it as a write outside
    // the worktree would have denied most of a normal build.
    "ls -la .skakel/scratch/ 2>/dev/null; grep -n FOO deploy.yml",
    "pnpm test 2>&1 | tail -30",
    "git diff --name-only HEAD~1 HEAD 2>/dev/null || git status --short",
  ]) {
    assert.equal(sh(cmd).verdict, "allow", `expected allow: ${cmd}`);
  }
});

test("the safe /dev sinks are writable; a raw device is not", () => {
  assert.equal(sh("echo hi > /dev/null").verdict, "allow");
  assert.equal(sh("echo hi > /dev/sda").verdict, "deny");
});

test("the toolchain and its config stay readable, and unwritable", () => {
  // These are reads a build genuinely makes: `git` reads /etc/gitconfig and ~/.gitconfig, anything
  // over HTTPS reads /etc/ssl. Deny them and nothing works, so `ro` grants them - reads only.
  assert.equal(sh("cat ~/.gitconfig").verdict, "allow");
  assert.equal(sh("cat /etc/hosts").verdict, "allow");
  assert.equal(sh("ls /usr/bin").verdict, "allow");
  assert.equal(sh("/usr/bin/env node --version").verdict, "allow");

  // Read-only means read-only: writing to the toolchain is not a build step.
  assert.equal(sh("touch /usr/local/bin/whoops").verdict, "deny");
  assert.equal(sh("rm -rf /etc/hosts").verdict, "deny");

  // A credential under an otherwise-readable root is denied outright: `deny` beats `ro`.
  assert.equal(sh("cat ~/.ssh/config").verdict, "deny");
  assert.equal(sh("cat ~/.aws/credentials").verdict, "deny");
  assert.equal(sh("cat /etc/sudoers").verdict, "deny");
});

test("an agent may still tidy a throwaway dir it created (the tmp pin holds)", () => {
  // Pinned by the shell_guard suite: blanket-blocking absolute paths would mean an agent could not
  // clean up after its own verification. tmp is a root precisely so this keeps working.
  assert.equal(sh("rm -rf /tmp/sl340-test /tmp/driver-debug.log").verdict, "allow");
  assert.equal(sh("cd /tmp && rm -rf sl340-test").verdict, "allow");
});

test("path-bearing tools are checked on their path fields", () => {
  assert.equal(verdict("Read", { file_path: join(homedir(), "Documents", "tax.pdf") }).verdict, "deny");
  assert.equal(verdict("Read", { file_path: join(homedir(), ".ssh", "id_rsa") }).verdict, "deny");
  assert.equal(verdict("Write", { file_path: "/etc/hosts" }).verdict, "deny");
  assert.equal(verdict("Glob", { path: "/" }).verdict, "deny");
  assert.equal(verdict("Grep", { path: "/Users", pattern: "password" }).verdict, "deny");
  assert.equal(verdict("apply_patch", { changes: { "/etc/hosts": { kind: "update" } } }).verdict, "deny");

  assert.equal(verdict("Read", { file_path: join(WT, "package.json") }).verdict, "allow");
  assert.equal(verdict("Write", { file_path: join(WT, "src", "new.ts") }).verdict, "allow");
  assert.equal(verdict("Read", { file_path: join(SCRATCH, "issue.md") }).verdict, "allow");
  assert.equal(verdict("Grep", { path: "src", pattern: "foo" }).verdict, "allow");
  // Grep's `glob` is an rg --glob FILTER, not a root: path-checking it would deny every `**/*.ts`.
  assert.equal(verdict("Grep", { path: "src", pattern: "foo", glob: "**/*.ts" }).verdict, "allow");
  // A read tool may read the toolchain; a write tool may not write it.
  assert.equal(verdict("Read", { file_path: "/usr/lib/node_modules/x.js" }).verdict, "allow");
  assert.equal(verdict("Write", { file_path: "/usr/lib/node_modules/x.js" }).verdict, "deny");
});

test("a command whose quoting cannot be parsed is denied, not waved through", () => {
  // It would fail in the shell anyway, so refusing it costs nothing - and this guard fails closed.
  const out = sh("rg 'unbalanced");
  assert.equal(out.verdict, "deny");
  assert.match(out.reason ?? "", /could not be parsed/);
});

test("confinement is off when the node has no roots, and killable by an operator", () => {
  // No fsRoots (an embedder with no workspace): the rule is simply not built.
  const bare = buildRules([], { worktreePath: WT, repoName: "r", runToolCalls: { count: 0 } });
  assert.equal(
    evaluatePolicies({ kind: "action", stageId: "build", tool: "Bash", input: { command: "find / -name x" } }, bare)
      .verdict,
    "allow",
  );

  // DAHRK_FS_CONFINE=0 is the valve for a node broken by a false positive, with no release to wait for.
  process.env.DAHRK_FS_CONFINE = "0";
  try {
    assert.equal(sh("find / -name x").verdict, "allow");
  } finally {
    delete process.env.DAHRK_FS_CONFINE;
  }
  assert.equal(sh("find / -name x").verdict, "deny", "and back on when the valve is closed");
});
