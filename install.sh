#!/bin/sh
# install.sh - install the dahrk-node client and, given a connect token, enrol this machine as a node
# in one copy-paste. Served at https://dahrk.ai/install.sh, so it is written for POSIX `sh` and is
# safe to pipe straight into a shell:
#
#   curl -fsSL https://dahrk.ai/install.sh | sh                                # install only
#   curl -fsSL https://dahrk.ai/install.sh | sh -s -- --token <connect-token>  # install + enrol
#
# It installs `dahrk-node` from npm (the same version the npm and Homebrew channels ship), then hands
# the token to the client's own commands: `dahrk doctor` preflights it, `dahrk start` enrols the node
# and installs the always-on service. It does NOT install a Node runtime; it requires Node 22+ already
# on PATH and fails loudly if it is missing. Every bad input - unsupported OS, missing or old Node, a
# failed install, a bad token - exits non-zero with a legible message, never a silent half-install.
#
# Idempotent: the client persists a stable node id at ~/.dahrk/node.json, so re-running this upgrades
# the client and re-attaches as the same node rather than creating a duplicate.
set -eu

# The Node floor: matches `engines.node` in the published package.
NODE_MIN_MAJOR=22

# A legible failure: message to stderr, non-zero exit. Every guard below routes through this.
fail() {
  echo "dahrk install: $1" >&2
  exit 1
}

# --- arguments and environment -------------------------------------------------------------------
# A flag wins over the matching environment variable. DAHRK_TOKEN is the installer's spelling of the
# connect token; it is handed to the client as --token. DAHRK_HUB_URL overrides the hub for
# self-hosters and staging (the client defaults it to wss://api.dahrk.ai).
token=${DAHRK_TOKEN:-}
hub_url=${DAHRK_HUB_URL:-}
no_service=0

while [ $# -gt 0 ]; do
  case "$1" in
    --token) [ $# -ge 2 ] || fail "--token needs a value"; token=$2; shift 2 ;;
    --token=*) token=${1#--token=}; shift ;;
    --hub-url) [ $# -ge 2 ] || fail "--hub-url needs a value"; hub_url=$2; shift 2 ;;
    --hub-url=*) hub_url=${1#--hub-url=}; shift ;;
    --no-service) no_service=1; shift ;;
    -h | --help)
      echo "Usage: install.sh [--token <connect-token>] [--hub-url <url>] [--no-service]"
      echo "  Installs dahrk-node; with a token, also enrols this machine as a node."
      exit 0
      ;;
    *) fail "unknown option: $1 (try --help)" ;;
  esac
done

# --- operating system ----------------------------------------------------------------------------
# macOS and Linux only. Name Windows explicitly, since a curious Windows user is the likely case and
# WSL2 is the supported answer there.
os=$(uname -s 2>/dev/null || echo unknown)
case "$os" in
  Darwin | Linux) ;;
  MINGW* | MSYS* | CYGWIN* | Windows*)
    fail "Windows is not supported. Run dahrk-node inside WSL2 (a Linux shell), or see https://dahrk.ai/docs/install." ;;
  *)
    fail "unsupported operating system: $os. dahrk-node supports macOS and Linux." ;;
esac

# --- Node 22+ ------------------------------------------------------------------------------------
# The client is a Node program; this script does not install a runtime, so a missing or too-old Node
# is a hard, legible stop rather than an attempt to fix it.
command -v node >/dev/null 2>&1 ||
  fail "Node ${NODE_MIN_MAJOR}+ is required but 'node' was not found on PATH. Install it from https://nodejs.org and re-run this command."

node_version=$(node -v 2>/dev/null) || fail "could not run 'node -v' to check the Node version."
node_major=${node_version#v}
node_major=${node_major%%.*}
case "$node_major" in
  '' | *[!0-9]*) fail "could not read the Node version from '${node_version}'. Install Node ${NODE_MIN_MAJOR}+ and re-run." ;;
esac
[ "$node_major" -ge "$NODE_MIN_MAJOR" ] ||
  fail "Node ${NODE_MIN_MAJOR}+ is required, but this is ${node_version}. Upgrade Node (https://nodejs.org) and re-run. This installer does not install Node for you."

# --- install the client --------------------------------------------------------------------------
echo "==> Installing dahrk-node (npm install -g dahrk-node)"
npm install -g dahrk-node ||
  fail "'npm install -g dahrk-node' failed (see the error above; a permissions or registry problem is usual). Fix it and re-run."

# --- no token: install only, print the next step -------------------------------------------------
if [ -z "$token" ]; then
  echo ""
  echo "dahrk-node is installed. To enrol this machine as a node, run:"
  echo ""
  echo "    dahrk start --token <your-connect-token>"
  echo ""
  echo "Get a connect token at https://app.dahrk.ai."
  exit 0
fi

# --- token: preflight, then enrol ----------------------------------------------------------------
# Preflight the token before committing to enrol. `dahrk doctor` checks Node, runtimes, hub
# reachability and the token itself, and exits non-zero on a missing / expired / consumed / revoked
# token. We stop there on failure - the client stays installed, so a re-run with a fresh token just
# works, no rollback.
set -- doctor --token "$token"
if [ -n "$hub_url" ]; then set -- "$@" --hub-url "$hub_url"; fi
echo "==> Checking the connect token (dahrk doctor)"
dahrk "$@" ||
  fail "the connect token was not accepted (see the doctor output above). Get a fresh token at https://app.dahrk.ai and re-run; the client stays installed."

# Good token: enrol. `dahrk start` persists the token, installs the always-on service, and returns.
# --no-service enrols without installing the daemon, for users who supervise the node themselves.
set -- start --token "$token"
if [ -n "$hub_url" ]; then set -- "$@" --hub-url "$hub_url"; fi
if [ "$no_service" -eq 1 ]; then set -- "$@" --no-service; fi
echo "==> Enrolling this node (dahrk start)"
dahrk "$@"
