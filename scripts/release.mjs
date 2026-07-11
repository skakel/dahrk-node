#!/usr/bin/env node
// Prepare a `dahrk-node` release: draft the changelog, bump versions, and open a "Release x.y.z" PR.
//
//   pnpm release <version> [--ai-polish] [--no-ai] [--dry-run]
//
// This handles only the prep. Merging the PR it opens lets tag-release.yml push the vX.Y.Z tag, which
// triggers release.yml to publish to npm + Homebrew + GitHub Releases. See README "Releasing".
//
// Steps: preflight (clean tree, on main, tag free, gh authed) -> branch release/X.Y.Z -> resolve the
// changelog section (hand-written [Unreleased] entries win; otherwise draft from the commit log with
// claude-opus-4-8) -> bump apps/edge-node + root package.json -> rewrite CHANGELOG.md (fresh
// [Unreleased], new [X.Y.Z], repointed compare links) -> commit, push, open the PR with the section as
// the body (so the same reviewed text becomes the GitHub Release notes).

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'dahrkai/dahrk-node'
const EDGE_PKG = join(ROOT, 'apps/edge-node/package.json')
const ROOT_PKG = join(ROOT, 'package.json')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')
// Internal-only companion (never published). Rolled alongside CHANGELOG.md but left verbatim — it may
// carry tracker keys and internal notes. Optional: if absent, the internal roll is skipped.
const CHANGELOG_INTERNAL = join(ROOT, 'CHANGELOG.internal.md')

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.filter((a) => !a.startsWith('--'))
const DRY_RUN = flags.has('--dry-run')
const NO_AI = flags.has('--no-ai')
const AI_POLISH = flags.has('--ai-polish')
// --out=<file>: also write the resolved (sanitised) notes to a file. Used by the preview-release-notes
// CI job to capture just the notes; works in --dry-run too.
const OUT = (args.find((a) => a.startsWith('--out=')) ?? '').slice('--out='.length) || null

const die = (msg) => {
  console.error(`\x1b[31mrelease:\x1b[0m ${msg}`)
  process.exit(1)
}
const step = (msg) => console.log(`\x1b[36m→\x1b[0m ${msg}`)

// git/gh helpers — throw on non-zero so preflight failures are loud.
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
const gitOk = (...a) => {
  try {
    execFileSync('git', a, { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ---- parse + validate version -------------------------------------------------------------------
const version = (positional[0] ?? '').replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  die(`usage: pnpm release <version> [--ai-polish] [--no-ai] [--dry-run]  (got: ${positional[0] ?? '<none>'})`)
}
const tag = `v${version}`

// ---- preflight ----------------------------------------------------------------------------------
// --dry-run previews only, so it skips the mutation-safety guards (clean tree, on main, gh auth) and
// runs from wherever you are. A real run enforces all of them.
step(DRY_RUN ? 'preflight (dry-run)' : 'preflight')
git('fetch', 'origin', '--tags', '--quiet')
if (!DRY_RUN) {
  if (git('status', '--porcelain')) die('working tree is not clean — commit or stash first')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') die(`must be on main (currently on ${branch})`)
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
    die('local main is not in sync with origin/main — pull/push first')
  }
  if (git('tag', '--list', tag) || gitOk('ls-remote', '--exit-code', '--tags', 'origin', tag)) {
    die(`tag ${tag} already exists`)
  }
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' })
  } catch {
    die('gh is not authenticated — run `gh auth login` (needed to open the release PR)')
  }
}

// PREV = most recent existing release tag, for the compare link + commit range.
const prevVersion = readChangelogVersions()[0] ?? null
const prevTag = prevVersion ? `v${prevVersion}` : null

// ---- resolve the changelog section --------------------------------------------------------------
const unreleased = readUnreleasedBody()
let section
if (unreleased && !AI_POLISH) {
  step('using hand-written [Unreleased] entries')
  section = unreleased
} else {
  section = await draftSection(unreleased)
}
// Scrub internal identifiers regardless of source (hand-written, AI, or fallback) — these notes are
// public.
section = sanitizeNotes(section).trim()
if (!section) die('resolved an empty changelog section — nothing to release')

if (OUT) {
  writeFileSync(OUT, section + '\n')
  step(`wrote notes to ${OUT}`)
}

// ---- compute file rewrites ----------------------------------------------------------------------
const changelogNext = rewriteChangelog(version, section, prevVersion)
const internalNext = rollInternalChangelog(version) // null when the file is absent
const edgeNext = bumpPackage(EDGE_PKG, version)
const rootNext = bumpPackage(ROOT_PKG, version)

if (DRY_RUN) {
  console.log('\n\x1b[33m--- [dry-run] CHANGELOG [' + version + '] section ---\x1b[0m\n')
  console.log(section)
  console.log('\n\x1b[33m--- [dry-run] versions ---\x1b[0m')
  console.log(`apps/edge-node/package.json + package.json  →  ${version}`)
  if (internalNext !== null) console.log(`CHANGELOG.internal.md  →  rolled [Unreleased] into [${version}]`)
  console.log('\n\x1b[33m[dry-run] no files written, no branch/commit created.\x1b[0m')
  process.exit(0)
}

// ---- apply --------------------------------------------------------------------------------------
step(`branch release/${version}`)
git('switch', '-c', `release/${version}`)

writeFileSync(CHANGELOG, changelogNext)
if (internalNext !== null) {
  writeFileSync(CHANGELOG_INTERNAL, internalNext)
  step('rolled CHANGELOG.internal.md')
}
writeFileSync(EDGE_PKG, edgeNext)
writeFileSync(ROOT_PKG, rootNext)
step(`bumped apps/edge-node + root package.json → ${version}`)

git('commit', '-am', `Release ${version}`)
git('push', '-u', 'origin', `release/${version}`, '--quiet')
step(`pushed release/${version}`)

const pr = execFileSync('gh', ['pr', 'create', '--title', `Release ${version}`, '--body', section], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim()
step(`opened PR: ${pr}`)
console.log('\nReview/edit the changelog in the PR, then merge. CI tags the release and publishes.')

// ================================================================================================
// helpers
// ================================================================================================

// Return all versioned headings (`## [x.y.z]`) in file order, newest first.
function readChangelogVersions() {
  const text = readFileSync(CHANGELOG, 'utf8')
  return [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1])
}

// Body between `## [Unreleased]` and the next `## ` heading, trimmed.
function readUnreleasedBody() {
  const text = readFileSync(CHANGELOG, 'utf8')
  const m = text.match(/^## \[Unreleased\]\s*\n([\s\S]*?)(?=^## |\n\[Unreleased\]:)/m)
  return (m ? m[1] : '').trim()
}

// Rebuild the file: fresh empty [Unreleased], new [version] section, repointed compare links.
function rewriteChangelog(version, section, prevVersion) {
  let text = readFileSync(CHANGELOG, 'utf8')

  // Replace the [Unreleased] block (heading + body, up to the next `## ` or the link refs) with an
  // empty [Unreleased] followed by the new dated version section (Keep a Changelog convention).
  const date = new Date().toISOString().slice(0, 10)
  const block = `## [Unreleased]\n\n## [${version}] - ${date}\n\n${section}\n\n`
  text = text.replace(/^## \[Unreleased\]\s*\n[\s\S]*?(?=^## |\n\[Unreleased\]:)/m, block)

  // Compare links at the foot.
  text = text.replace(
    /^\[Unreleased\]:.*$/m,
    `[Unreleased]: https://github.com/${REPO}/compare/v${version}...HEAD`,
  )
  const prevRef = prevVersion
    ? `compare/v${prevVersion}...v${version}`
    : `releases/tag/v${version}`
  const newLink = `[${version}]: https://github.com/${REPO}/${prevRef}`
  // Insert directly after the [Unreleased]: line.
  text = text.replace(/^(\[Unreleased\]:.*$)/m, `$1\n${newLink}`)

  return text
}

// Roll the internal changelog's [Unreleased] into a dated [version] section, verbatim (no sanitising —
// internal notes may carry tracker keys). Returns the new text, or null if the file is absent (it is
// optional). No compare-link footer to maintain; the [Unreleased] block runs to the next `## ` heading
// or end of file.
function rollInternalChangelog(version) {
  let text
  try {
    text = readFileSync(CHANGELOG_INTERNAL, 'utf8')
  } catch {
    return null
  }
  const head = text.match(/^## \[Unreleased\][^\n]*\n/m)
  if (!head) die('CHANGELOG.internal.md has no [Unreleased] section')
  const bodyStart = head.index + head[0].length
  // Next `## ` heading after [Unreleased], or end of file.
  const rest = text.slice(bodyStart)
  const nextHeading = rest.search(/^## /m)
  const bodyEnd = nextHeading === -1 ? text.length : bodyStart + nextHeading
  const body = text.slice(bodyStart, bodyEnd).trim()

  const date = new Date().toISOString().slice(0, 10)
  const rolled = body ? `${body}\n\n` : ''
  const block = `## [Unreleased]\n\n## [${version}] - ${date}\n\n${rolled}`
  return text.slice(0, head.index) + block + text.slice(bodyEnd)
}

// Bump `version` in a package.json, preserving 2-space indent + trailing newline.
function bumpPackage(path, version) {
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.version = version
  return JSON.stringify(pkg, null, 2) + '\n'
}

// Strip internal identifiers so they can never reach the public notes, whatever the source. Removes
// Linear-style tracker keys, internal run IDs, and commit trailers, then tidies the fallout (empty
// parens left behind, doubled spaces, trailing whitespace).
function sanitizeNotes(text) {
  return text
    .replace(/^(?:Co-authored-by|Signed-off-by):.*$/gim, '') // commit trailers
    .replace(/\b(?:DHK|SKA|LABS|TEST|HAR|SL)-\d+\b/g, '') // Linear-style keys
    .replace(/\brun-[a-z0-9]{6,}\b/gi, '') // internal run IDs
    .replace(/\(\s*[,\s]*\)/g, '') // parens emptied by the removals: "(DHK-284)" -> ""
    .replace(/[ \t]+([),.:;])/g, '$1') // space before punctuation left by a removal
    .replace(/(\S)[ \t]{2,}/g, '$1 ') // squeeze doubled spaces mid-line (preserve leading indent)
    .replace(/[ \t]+$/gm, '') // trailing whitespace
    .replace(/\n{3,}/g, '\n\n') // collapse gaps a trailer line left behind
}

// Draft a Keep-a-Changelog section from the commit log using claude-opus-4-8. Falls back to the raw
// commit list if --no-ai, no SDK/key, or a refusal.
async function draftSection(unreleasedFallback) {
  const range = prevTag ? `${prevTag}..HEAD` : 'HEAD'
  // Subjects only (no `%b` bodies) — bodies carry trailers, internal `run-…` IDs, and tracker keys we
  // don't want in public notes. Subjects keep the human summary + the `(#N)` GitHub ref.
  const log = git('log', '--no-merges', `--pretty=format:- %s`, range).trim()
  const rawList = log || unreleasedFallback || `- Release ${version}.`

  if (NO_AI) {
    step('drafting section from commit log (--no-ai)')
    return rawList
  }

  step('drafting changelog from commit log via claude-opus-4-8')
  let Anthropic
  try {
    ;({ default: Anthropic } = await import('@anthropic-ai/sdk'))
  } catch {
    console.warn('  @anthropic-ai/sdk not installed — falling back to the raw commit list')
    return rawList
  }

  try {
    const client = new Anthropic()
    const res = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2000,
      system:
        'You write public release notes for dahrk-node, the open-source Dahrk edge client. ' +
        'Audience: people who install and run the client, not its developers. Describe what changed ' +
        'and why it matters to them, not the commit mechanics. ' +
        'Lead with the most notable change, then group the rest under ### Added / ### Changed / ' +
        '### Fixed (omit empty groups). One bullet per change. ' +
        'Where a commit subject carries a GitHub reference like "(#7)", keep that "(#N)" reference on ' +
        'the bullet. NEVER include internal tracker keys (e.g. DHK-284, SKA-…, LABS-…, TEST-…, HAR-…, ' +
        'SL-…), internal run IDs (run-…), branch names, or commit trailers (Co-authored-by, etc.). ' +
        'No raw commit messages. British English, no em dashes. ' +
        'Output only the markdown body — no version heading, no preamble, no code fences.',
      messages: [
        {
          role: 'user',
          content: `Version ${version}. Commits since ${prevTag ?? 'the beginning'}:\n\n${rawList}`,
        },
      ],
    })
    if (res.stop_reason === 'refusal') {
      console.warn('  model declined — falling back to the raw commit list')
      return rawList
    }
    const out = res.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim()
    return out || rawList
  } catch (err) {
    console.warn(`  changelog draft failed (${err.message}) — falling back to the raw commit list`)
    return rawList
  }
}
