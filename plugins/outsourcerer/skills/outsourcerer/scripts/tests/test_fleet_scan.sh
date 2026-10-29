#!/usr/bin/env bash
# test_fleet_scan.sh — the two fleet-scan speedups keep their answers honest:
#   1. _job_logscan caches what _job_json derives from out.log, keyed on the log's size + mtime (and the
#      history length): a cache hit gives the same values as a fresh scan, a grown log or a different
#      OSRC_PROGRESS_HISTORY is rescanned, a corrupt cache is ignored.
#   2. the agent-process scan keeps only real CLIs (executable claude / codex, or node running Claude Code
#      or Codex), not every process that mentions the word (desktop-app helpers, shells, other tools).
# Fixture job dirs and a stubbed `ps`; offline.
#
# Run: bash test_fleet_scan.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../outsourcerer.sh"
bash -n "$SRC" || { echo "FAIL: bash -n failed for $SRC"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required for this test"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/osrc-fleetscan.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"; mkdir -p "$HOME"
export OSRC_HOME="$TMP/state"; mkdir -p "$OSRC_HOME/jobs"
export OSRC_SOURCED=1 OSRC_RECONCILE_READ_ONLY=1 OSRC_FLEET_SUPERVISION=0 OSRC_HEARTBEAT_DISABLED=1 OSRC_BLIND_TURN_GUARD=0
. "$SRC" >/dev/null 2>&1
for f in _job_logscan _job_json _external_session_observations _size_mtime; do type -t "$f" >/dev/null || { echo "FAIL: $f not loaded"; exit 1; }; done

pass=0; fail=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }

# --- 1. the log-scan cache --------------------------------------------------------------------------------
jd="$OSRC_JOBS/j-1"; mkdir -p "$jd"
printf 'running\n' > "$jd/status"
printf '{"id":"j-1","provider":"claude","verb":"edit","model":"opus","started":1700000000}\n' > "$jd/meta.json"
cat > "$jd/out.log" <<'EOF'
{"type":"system","subtype":"init","model":"claude-opus-4-7"}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"},{"type":"tool_use","name":"Edit"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"OSRC::PROGRESS 1/2 reading the spec"}]}}
EOF
fresh() { OSRC_PROGRESS_HISTORY="${1:-10}" _job_json j-1 | jq -cS '{progress, observed_model}'; }
a="$(fresh)"
[ -f "$jd/.logscan" ] && ok "the first read writes .logscan" || bad "no cache file"
mode="$(stat -c %a "$jd/.logscan" 2>/dev/null || stat -f %Lp "$jd/.logscan")"
[ "$mode" = 600 ] && ok "the cache file is private (0600)" || bad "cache mode $mode"
b="$(fresh)"
[ "$a" = "$b" ] && ok "a cache hit gives the same fields as the fresh scan" || bad "hit differs: $a vs $b"
printf '%s' "$a" | jq -e '.progress.reads == 1 and .progress.writes == 1 and .progress.line == "1/2 reading the spec" and .observed_model == "claude-opus-4-7"' >/dev/null \
  && ok "the cached fields are the real ones" || bad "fields: $a"
# the cache really is used: a cache whose key matches is believed (proves no rescan on a hit)
key="$(head -1 "$jd/.logscan")"
printf '%s\n9\n9\n9\nOSRC::DONE\nfake-model\nfrom cache\n' "$key" > "$jd/.logscan"
c="$(fresh)"
printf '%s' "$c" | jq -e '.progress.reads == 9 and .observed_model == "fake-model"' >/dev/null && ok "a matching cache is read instead of rescanning" || bad "cache not used: $c"
# a grown log is rescanned
sleep 1
printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"},{"type":"text","text":"OSRC::PROGRESS 2/2 running tests"}]}}\n' >> "$jd/out.log"
d="$(fresh)"
printf '%s' "$d" | jq -e '.progress.reads == 1 and .progress.bash == 1 and .progress.line == "2/2 running tests" and .observed_model == "claude-opus-4-7"' >/dev/null \
  && ok "a grown log is rescanned" || bad "stale after append: $d"
# another history length is another key
e="$(fresh 1)"
printf '%s' "$e" | jq -e '(.progress.history | length) == 1' >/dev/null && ok "a different OSRC_PROGRESS_HISTORY is rescanned" || bad "history length: $e"
# a corrupt cache is ignored
printf 'garbage\n' > "$jd/.logscan"
f="$(fresh)"
[ "$f" = "$d" ] && ok "a corrupt cache is ignored and rebuilt" || bad "corrupt cache: $f"
# a symlinked cache is never read
rm -f "$jd/.logscan"; printf 'v1 x\n' > "$TMP/evil"; ln -s "$TMP/evil" "$jd/.logscan"
g="$(fresh)"
[ "$g" = "$d" ] && ok "a symlinked cache is not trusted" || bad "symlink cache: $g"
rm -f "$jd/.logscan"
# a job with no log
mkdir -p "$OSRC_JOBS/j-2"; printf 'launching\n' > "$OSRC_JOBS/j-2/status"
printf '{"id":"j-2","provider":"codex","verb":"run","model":"m","started":1700000000}\n' > "$OSRC_JOBS/j-2/meta.json"
_job_json j-2 | jq -e '.progress.reads == 0 and .progress.line == null and .observed_model == null' >/dev/null && ok "no log: zero counts, null fields" || bad "no-log job"
[ ! -e "$OSRC_JOBS/j-2/.logscan" ] && ok "no log: nothing cached" || bad "cached a missing log"

# --- 2. the agent-process scan ---------------------------------------------------------------------------------
ps() {   # stub: the process table the scan sees, plus each node's argv
  case "$*" in
    "-axo pid=,ucomm=") printf '%s\n' \
      " 101 claude" " 102 codex" " 103 Claude Helper" " 104 Python" " 105 zsh" " 106 node" " 107 node" " 108 Codex" " 109 disclaimer" ;;
    "-o args= -p 106") echo "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume" ;;
    "-o args= -p 107") echo "node /opt/mcp/server.js --root /Users/me/.claude" ;;
    *) command ps "$@" ;;
  esac
}
_pid_start_identity() { printf 'start-%s' "$1"; }
OSRC_SESSION_REGISTRY="$TMP/none.jsonl"
items="$(_external_session_observations '[]' 2>/dev/null)"
got="$(printf '%s' "$items" | jq -r '[.[] | select(.session_id | startswith("proc.")) | .session_id] | sort | join(" ")')"
[ "$got" = "proc.101 proc.102 proc.106" ] && ok "only real agent CLIs are kept (claude, codex, node running claude-code)" || bad "kept: [$got]"
printf '%s' "$items" | jq -e '[.[] | select(.session_id == "proc.101")][0] | .harness == "process" and .harness_pid == "101" and .pid_start == "start-101"' >/dev/null \
  && ok "a kept process carries its pid and start identity" || bad "process item: $items"

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
