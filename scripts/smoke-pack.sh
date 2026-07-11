#!/usr/bin/env bash
# Smoke-test the *packaged* client the way a user installs it: pack the tarball, install it into a
# clean directory (so external deps like @dahrk/contracts resolve fresh from the registry, not the
# workspace), and run `dahrk version`. This exercises the whole ESM import graph at load time, which
# is where dahrk-node@0.1.5 crashed (a dependency shipped uncompiled TypeScript). Unit tests import
# src/*.ts directly and never touch the bundle, so this is the only check that catches it.
#
# Runs in CI (uses $RUNNER_TEMP) and locally (falls back to mktemp). Exits non-zero on any failure.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
TMP=${RUNNER_TEMP:-$(mktemp -d)}
EXPECT=$(node -p "require('$ROOT/apps/edge-node/package.json').version")

echo "==> packing dahrk-node@$EXPECT"
# pnpm pack prints progress; the tarball path is the final line.
TARBALL=$(cd "$ROOT/apps/edge-node" && pnpm pack --pack-destination "$TMP" | tail -1)
echo "==> tarball: $TARBALL"

WORK="$TMP/smoke-install"
rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"
npm init -y >/dev/null
echo "==> installing the tarball into a clean tree (deps resolved from the registry)"
npm install --no-audit --no-fund "$TARBALL" >/dev/null

echo "==> running the installed binary"
OUT=$(./node_modules/.bin/dahrk version)
echo "    dahrk version -> $OUT"

if [ "$OUT" != "$EXPECT" ]; then
  echo "::error::smoke test failed: 'dahrk version' printed '$OUT', expected '$EXPECT'" >&2
  exit 1
fi
echo "==> smoke OK: the packaged client loads and reports $OUT"
