import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseGitUrl, deriveRepoId, deriveRepoName, parseGitRemote } from "../src/repo-add.ts";

// -- parseGitRemote ----------------------------------------------------------

test("parseGitRemote: an SSH scp-style remote resolves to host/owner/repo", () => {
  assert.deepEqual(parseGitRemote("git@github.com:org/repo.git"), {
    host: "github.com",
    owner: "org",
    repo: "repo",
  });
});

test("parseGitRemote: an HTTPS remote resolves to the same host/owner/repo", () => {
  assert.deepEqual(parseGitRemote("https://github.com/org/repo.git"), {
    host: "github.com",
    owner: "org",
    repo: "repo",
  });
});

test("parseGitRemote: the trailing .git is optional", () => {
  assert.deepEqual(parseGitRemote("https://github.com/org/repo"), {
    host: "github.com",
    owner: "org",
    repo: "repo",
  });
});

test("parseGitRemote: an ssh:// URL (with a port) resolves too", () => {
  assert.deepEqual(parseGitRemote("ssh://git@github.com:22/org/repo.git"), {
    host: "github.com",
    owner: "org",
    repo: "repo",
  });
});

test("parseGitRemote: junk that is not a remote is undefined, not a crash", () => {
  assert.equal(parseGitRemote("not a url"), undefined);
  assert.equal(parseGitRemote(""), undefined);
  assert.equal(parseGitRemote("https://github.com/onlyowner"), undefined);
});

test("parseGitRemote: a nested org path (GitLab subgroup) joins all non-last segments as the owner", () => {
  assert.deepEqual(parseGitRemote("git@gitlab.com:group/subgroup/repo.git"), {
    host: "gitlab.com",
    owner: "group/subgroup",
    repo: "repo",
  });
  assert.deepEqual(parseGitRemote("https://gitlab.com/group/subgroup/repo.git"), {
    host: "gitlab.com",
    owner: "group/subgroup",
    repo: "repo",
  });
});

// -- chooseGitUrl (the SSH-vs-HTTPS decision) --------------------------------

test("chooseGitUrl: an HTTPS origin is kept as-is", () => {
  assert.deepEqual(chooseGitUrl({ originUrl: "https://github.com/org/repo.git", sshKeyPresent: false }), {
    gitUrl: "https://github.com/org/repo.git",
    converted: false,
  });
});

test("chooseGitUrl: an SSH origin is kept when an SSH key is present", () => {
  assert.deepEqual(chooseGitUrl({ originUrl: "git@github.com:org/repo.git", sshKeyPresent: true }), {
    gitUrl: "git@github.com:org/repo.git",
    converted: false,
  });
});

test("chooseGitUrl: an SSH origin with no key is normalised to canonical HTTPS and flagged", () => {
  assert.deepEqual(chooseGitUrl({ originUrl: "git@github.com:org/repo.git", sshKeyPresent: false }), {
    gitUrl: "https://github.com/org/repo.git",
    converted: true,
  });
});

test("chooseGitUrl: an unparseable SSH-like URL is passed through unchanged, never mangled", () => {
  // A local path or garbage that looks neither HTTPS nor SCP should not be destroyed.
  assert.deepEqual(chooseGitUrl({ originUrl: "not-a-remote", sshKeyPresent: false }), {
    gitUrl: "not-a-remote",
    converted: false,
  });
});

// -- deriveRepoName / deriveRepoId -------------------------------------------

test("deriveRepoName returns the repo slug without the .git suffix", () => {
  assert.equal(deriveRepoName(parseGitRemote("git@github.com:org/repo.git")!), "repo");
});

test("deriveRepoId is stable across calls for the same repo", () => {
  const a = deriveRepoId("https://github.com/org/repo.git");
  const b = deriveRepoId("https://github.com/org/repo.git");
  assert.equal(a, b);
});

test("deriveRepoId is equal for the SSH and normalised-HTTPS forms of one repo", () => {
  assert.equal(
    deriveRepoId("git@github.com:org/repo.git"),
    deriveRepoId("https://github.com/org/repo.git"),
    "re-running after a protocol conversion must dedupe against the same id",
  );
});

test("deriveRepoId does not crash or produce an empty string for a junk URL", () => {
  const id = deriveRepoId("not-a-url");
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0, "id must never be empty");
  assert.match(id, /^[a-z0-9-]+-[a-f0-9]{12}$/, "id must follow the slug-hash pattern even for junk input");
});
