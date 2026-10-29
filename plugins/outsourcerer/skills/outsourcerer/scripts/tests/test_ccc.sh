#!/usr/bin/env bash
# test_ccc.sh — `outsourcerer ccc`: find Claude Command Center the way its own client does ($CCC_SERVER,
# then ~/.claude/command-center/port.txt), accept only a loopback address, check it answers, and print or
# open it (optionally at ?session=<id>). A throwaway HTTP server stands in for CCC; nothing real is opened
# or started. Offline.
#
# Run: bash test_ccc.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../outsourcerer.sh"
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed"; exit 0; }
command -v curl >/dev/null 2>&1 || { echo "SKIP: curl not installed"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required for this test"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/osrc-ccc.XXXXXX")"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; wait 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
export HOME="$TMP/home"; mkdir -p "$HOME/.claude/command-center"
export OSRC_HOME="$TMP/state"; mkdir -p "$OSRC_HOME"
export OSRC_FLEET_SUPERVISION=0 OSRC_HEARTBEAT_DISABLED=1 OSRC_BLIND_TURN_GUARD=0
unset CCC_SERVER
PF="$HOME/.claude/command-center/port.txt"
# no browser, no real CCC: a stub `open`/`xdg-open` records what would be opened, `ccc` is absent
mkdir -p "$TMP/bin"
printf '#!/bin/sh\necho "$1" >> "%s/opened"\n' "$TMP" > "$TMP/bin/open"; cp "$TMP/bin/open" "$TMP/bin/xdg-open"; chmod +x "$TMP/bin/open" "$TMP/bin/xdg-open"
# A PATH that cannot reach a real `ccc`: only the dirs of the tools this test and the CLI need.
SAFE="$TMP/bin"
for t in bash jq curl python3 sed awk grep head tr cat date mktemp basename dirname uname ps sleep nohup cksum find ls rm mkdir chmod; do
  d="$(dirname "$(command -v "$t" 2>/dev/null)" 2>/dev/null)"; case ":$SAFE:" in *":$d:"*) ;; *) [ -n "$d" ] && SAFE="$SAFE:$d" ;; esac
done
export PATH="$SAFE"
if command -v ccc >/dev/null 2>&1; then echo "FAIL: a real ccc is still reachable on the test PATH ($(command -v ccc))"; exit 1; fi
O() { bash "$SRC" "$@" 2>"$TMP/err"; }

pass=0; fail=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }

# --- nothing published -----------------------------------------------------------------------------------
out="$(O ccc --json)"
printf '%s' "$out" | jq -e '.url == null and .running == false and .session_url == null' >/dev/null && ok "no port file: url null, not running" || bad "no port file: $out"
O ccc >/dev/null; rc=$?
[ "$rc" -ne 0 ] && grep -q 'ccc --start' "$TMP/err" && ok "not running: fails and says how to start it" || bad "not running: rc=$rc $(cat "$TMP/err")"

# --- a stand-in CCC on an ephemeral port ----------------------------------------------------------------
python3 -u -m http.server 0 --bind 127.0.0.1 --directory "$TMP" > "$TMP/http.log" 2>&1 & PID=$!
for _ in $(seq 1 50); do grep -q 'Serving HTTP' "$TMP/http.log" 2>/dev/null && break; sleep 0.1; done
PORT="$(sed -n 's/.*port \([0-9]*\).*/\1/p' "$TMP/http.log" | head -1)"
[ -n "$PORT" ] || { echo "FAIL: stand-in server did not start"; exit 1; }
printf 'http://127.0.0.1:%s\n' "$PORT" > "$PF"

out="$(O ccc --json)"
printf '%s' "$out" | jq -e --arg u "http://127.0.0.1:$PORT" '.url == $u and .running == true' >/dev/null && ok "port.txt is read and the server answers" || bad "port.txt: $out"
out="$(O ccc s-1 --json)"
printf '%s' "$out" | jq -e --arg u "http://127.0.0.1:$PORT/?session=s-1" '.session_url == $u' >/dev/null && ok "--json gives the session deep link" || bad "session_url: $out"
[ "$(O ccc --print-url)" = "http://127.0.0.1:$PORT" ] && ok "--print-url prints the address" || bad "--print-url"
[ "$(O ccc abc-123 --print-url)" = "http://127.0.0.1:$PORT/?session=abc-123" ] && ok "a session id becomes ?session=<id>" || bad "session url"
O ccc abc-123 >/dev/null && [ "$(tail -1 "$TMP/opened" 2>/dev/null)" = "http://127.0.0.1:$PORT/?session=abc-123" ] && ok "opens the deep link in the browser" || bad "open: $(cat "$TMP/opened" 2>/dev/null) $(cat "$TMP/err")"

# --- precedence and refusals -------------------------------------------------------------------------------
[ "$(CCC_SERVER="http://localhost:$PORT/" O ccc --print-url)" = "http://localhost:$PORT" ] && ok "\$CCC_SERVER wins over port.txt (trailing / dropped)" || bad "CCC_SERVER precedence"
out="$(CCC_SERVER=http://evil.example:80 O ccc --json)"
printf '%s' "$out" | jq -e '.url == null and .running == false' >/dev/null && ok "a non-loopback CCC_SERVER is refused" || bad "non-loopback accepted: $out"
printf 'http://10.0.0.5:8090\n' > "$PF"
out="$(O ccc --json)"; printf '%s' "$out" | jq -e '.url == null' >/dev/null && ok "a non-loopback port.txt is refused" || bad "LAN port.txt accepted"
printf 'javascript:alert(1)\n' > "$PF"
out="$(O ccc --json)"; printf '%s' "$out" | jq -e '.url == null' >/dev/null && ok "a non-http value is refused" || bad "odd scheme accepted"
printf 'http://127.0.0.1:%s\n' "$PORT" > "$PF"
( O ccc '../x' --print-url >/dev/null ) && bad "path-like session id must be refused" || ok "path-like session id refused"
( O ccc 'a b' --print-url >/dev/null ) && bad "session id with spaces must be refused" || ok "session id with spaces refused"
( O ccc --bogus >/dev/null ) && bad "unknown options must be refused" || ok "unknown options refused"
( O ccc a b --print-url >/dev/null ) && bad "two ids must be refused" || ok "one session id at most"

# --- --start with no ccc installed --------------------------------------------------------------------------
kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; PID=""
O ccc --start >/dev/null; rc=$?
[ "$rc" -ne 0 ] && grep -q "not installed" "$TMP/err" && ok "--start without ccc on PATH says it is not installed" || bad "--start: rc=$rc $(cat "$TMP/err")"

# --- --start with a ccc that never brings a server up: it is launched, then the wait times out --------------
printf '#!/bin/sh\necho started >> "%s/ccc-started"\n' "$TMP" > "$TMP/bin/ccc"; chmod +x "$TMP/bin/ccc"
OSRC_CCC_START_WAIT=2 O ccc --start >/dev/null; rc=$?
sleep 0.5
[ "$rc" -ne 0 ] && [ -f "$TMP/ccc-started" ] && grep -q "not answering" "$TMP/err" && ok "--start launches ccc, then reports it never answered" || bad "--start with stub: rc=$rc $(cat "$TMP/err")"
O ccc --json >/dev/null; [ "$(wc -l < "$TMP/ccc-started" 2>/dev/null | tr -d ' ')" = 1 ] && ok "--json never starts anything" || bad "--json started ccc"

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
