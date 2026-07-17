#!/usr/bin/env bash
# Behaviour tests for the root install.sh, without a network or a real client. Each case builds a
# temp dir of stub `uname` / `node` / `npm` / `dahrk` executables whose exit codes and echoed argv
# we control, prepends it to PATH, runs `install.sh`, and asserts on the captured argv + exit code.
# This exercises every branch (unsupported OS, missing/old Node, npm failure, no token, good token,
# bad token, env/flag precedence, --no-service) deterministically.
#
# Runs locally and in CI. Exits non-zero on the first failing assertion.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
SCRIPT="$ROOT/install.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

# Build a fresh stub PATH dir. Stubs log "<name> <args>" to $STUB_LOG so a case can assert what was
# (and was not) invoked and with which arguments. Version / exit-code behaviour is read from env at
# call time, so a case sets STUB_NODE_VER / STUB_NPM_EXIT / STUB_DOCTOR_EXIT etc. before running.
make_stubs() {
  local dir="$1"
  local with_node="${2:-1}"
  rm -rf "$dir"
  mkdir -p "$dir"

  cat >"$dir/uname" <<'EOF'
#!/bin/sh
echo "${STUB_UNAME:-Linux}"
EOF

  if [ "$with_node" = "1" ]; then
    cat >"$dir/node" <<'EOF'
#!/bin/sh
echo "node $*" >> "$STUB_LOG"
[ "$1" = "-v" ] && echo "${STUB_NODE_VER:-v22.3.0}"
exit 0
EOF
  fi

  cat >"$dir/npm" <<'EOF'
#!/bin/sh
echo "npm $*" >> "$STUB_LOG"
exit "${STUB_NPM_EXIT:-0}"
EOF

  cat >"$dir/dahrk" <<'EOF'
#!/bin/sh
echo "dahrk $*" >> "$STUB_LOG"
case "$1" in
  doctor) exit "${STUB_DOCTOR_EXIT:-0}" ;;
  start)  exit "${STUB_START_EXIT:-0}" ;;
  *)      exit 0 ;;
esac
EOF

  chmod +x "$dir"/*
}

# run <case-tag> [env assignments...] -- [install.sh args...]
# Populates globals: OUT (combined stdout+stderr), CODE (exit status), LOG (stub call log path).
run() {
  local dir="$WORK/stubs"
  local log="$WORK/log"
  : >"$log"
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift # drop --
  LOG="$log"
  set +e
  OUT=$(env -i PATH="$dir" STUB_LOG="$log" "${envs[@]}" /bin/sh "$SCRIPT" "$@" 2>&1)
  CODE=$?
  set -e
}

ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

assert_code() { # <expected> <label>
  if [ "$CODE" = "$1" ]; then ok; else bad "$2: exit $CODE, expected $1 (output: $OUT)"; fi
}
assert_code_nonzero() { # <label>
  if [ "$CODE" != "0" ]; then ok; else bad "$1: exit 0, expected non-zero (output: $OUT)"; fi
}
assert_out() { # <regex> <label>
  if echo "$OUT" | grep -Eq "$1"; then ok; else bad "$2: output did not match /$1/ (output: $OUT)"; fi
}
assert_log() { # <regex> <label>
  if grep -Eq "$1" "$LOG"; then ok; else bad "$2: stub log missing /$1/ (log: $(cat "$LOG"))"; fi
}
assert_no_log() { # <regex> <label>
  if grep -Eq "$1" "$LOG"; then bad "$2: stub log unexpectedly matched /$1/ (log: $(cat "$LOG"))"; else ok; fi
}

# --- unsupported OS ------------------------------------------------------------------------------
make_stubs "$WORK/stubs"
run STUB_UNAME=MINGW64_NT --
assert_code_nonzero "unsupported OS fails"
assert_out "[Ww]indows" "unsupported OS names Windows"
assert_no_log "^npm " "unsupported OS does not install"

# --- missing Node --------------------------------------------------------------------------------
make_stubs "$WORK/stubs" 0 # no node stub
run --
assert_code_nonzero "missing Node fails"
assert_out "Node 22" "missing Node message names the floor"
assert_no_log "^npm " "missing Node does not install"

# --- too-old Node --------------------------------------------------------------------------------
make_stubs "$WORK/stubs"
run STUB_NODE_VER=v20.11.0 --
assert_code_nonzero "old Node fails"
assert_out "Node 22" "old Node message names the floor"
assert_no_log "^npm " "old Node does not install"

# --- no token: install only ----------------------------------------------------------------------
make_stubs "$WORK/stubs"
run --
assert_code 0 "no token installs cleanly"
assert_log "^npm install -g dahrk-node$" "no token installs the client"
assert_out "dahrk start --token" "no token prints the next step"
assert_no_log "^dahrk " "no token does not enrol"

# --- no token, npm fails -------------------------------------------------------------------------
make_stubs "$WORK/stubs"
run STUB_NPM_EXIT=1 --
assert_code_nonzero "npm failure fails loudly"
assert_out "[Ii]nstall" "npm failure explains itself"

# --- good token: install + preflight + enrol -----------------------------------------------------
make_stubs "$WORK/stubs"
run -- --token sket_good
assert_code 0 "good token enrols cleanly"
assert_log "^npm install -g dahrk-node$" "good token installs the client"
assert_log "^dahrk doctor --token sket_good$" "good token preflights"
assert_log "^dahrk start --token sket_good$" "good token starts the node"

# --- bad token: doctor fails, start is skipped ---------------------------------------------------
make_stubs "$WORK/stubs"
run STUB_DOCTOR_EXIT=1 -- --token sket_bad
assert_code_nonzero "bad token fails"
assert_log "^dahrk doctor --token sket_bad$" "bad token still preflights"
assert_no_log "^dahrk start" "bad token never starts the node"

# --- token via DAHRK_TOKEN env -------------------------------------------------------------------
make_stubs "$WORK/stubs"
run DAHRK_TOKEN=sket_env --
assert_code 0 "env token enrols"
assert_log "^dahrk start --token sket_env$" "env token reaches start"

# --- flag beats env ------------------------------------------------------------------------------
make_stubs "$WORK/stubs"
run DAHRK_TOKEN=sket_env -- --token sket_flag
assert_log "^dahrk start --token sket_flag$" "flag token beats env token"

# --- hub-url is forwarded when set ---------------------------------------------------------------
make_stubs "$WORK/stubs"
run -- --token sket_good --hub-url ws://hub:7071
assert_log "^dahrk doctor --token sket_good --hub-url ws://hub:7071$" "hub-url reaches doctor"
assert_log "^dahrk start --token sket_good --hub-url ws://hub:7071$" "hub-url reaches start"

# --- --no-service enrols without the daemon ------------------------------------------------------
make_stubs "$WORK/stubs"
run -- --token sket_good --no-service
assert_log "^dahrk start --token sket_good --no-service$" "--no-service reaches start"

# --- DAHRK_HUB_URL env is forwarded to both doctor and start ------------------------------------
make_stubs "$WORK/stubs"
run DAHRK_TOKEN=sket_env DAHRK_HUB_URL=ws://env-hub:9090 --
assert_log "^dahrk doctor --token sket_env --hub-url ws://env-hub:9090$" "DAHRK_HUB_URL reaches doctor"
assert_log "^dahrk start --token sket_env --hub-url ws://env-hub:9090$" "DAHRK_HUB_URL reaches start"

# --- --token=value equals form -------------------------------------------------------------------
make_stubs "$WORK/stubs"
run -- --token=sket_equals
assert_code 0 "--token=value installs cleanly"
assert_log "^dahrk doctor --token sket_equals$" "--token=value reaches doctor"
assert_log "^dahrk start --token sket_equals$" "--token=value reaches start"

# --- --hub-url=value equals form -----------------------------------------------------------------
make_stubs "$WORK/stubs"
run -- --token sket_good --hub-url=ws://equals-hub:9091
assert_log "^dahrk doctor --token sket_good --hub-url ws://equals-hub:9091$" "--hub-url=value reaches doctor"
assert_log "^dahrk start --token sket_good --hub-url ws://equals-hub:9091$" "--hub-url=value reaches start"

# --- --token with no value is a legible error ----------------------------------------------------
make_stubs "$WORK/stubs"
run -- --token
assert_code_nonzero "--token with no value fails"
assert_out "[Nn]eeds a value" "--token with no value is legible"
assert_no_log "^npm " "--token with no value does not install"

# --- --help exits 0 with usage -------------------------------------------------------------------
make_stubs "$WORK/stubs"
run -- --help
assert_code 0 "--help exits 0"
assert_out "[Uu]sage" "--help prints usage"
assert_no_log "^npm " "--help does not install"

echo ""
echo "install.sh tests: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
