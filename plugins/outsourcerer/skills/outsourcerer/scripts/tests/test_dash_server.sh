#!/usr/bin/env bash
# test_dash_server.sh — the dashboard server's HTTP contract (seam 2 of the dashboard epic): loopback
# only, a 0600 token on every request, Host-header check, GET-only, an allow-list of endpoints that each
# pass one CLI --json command through unchanged, and validated path parameters. The UI is not tested
# here; it only renders what these endpoints return. Fixture state, offline.
#
# Run: bash test_dash_server.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../outsourcerer.sh"
SRV="$HERE/../dashboard/server.py"
[ -f "$SRV" ] || { echo "FAIL: cannot find $SRV"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed"; exit 0; }
command -v curl >/dev/null 2>&1 || { echo "SKIP: curl not installed"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required for this test"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/osrc-dash.XXXXXX")"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; wait 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
export HOME="$TMP/home"; mkdir -p "$HOME"
export OSRC_HOME="$TMP/state"; mkdir -p "$OSRC_HOME/jobs"
export OSRC_FLEET_SUPERVISION=0 OSRC_HEARTBEAT_DISABLED=1 OSRC_BLIND_TURN_GUARD=0

pass=0; fail=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }

# --- start-up refusals -----------------------------------------------------------------------------------
python3 "$SRV" --cli "$SRC" --home "$OSRC_HOME" --host 0.0.0.0 --port 0 >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "refuses a non-loopback --host" || bad "non-loopback host: rc=$rc"
python3 "$SRV" --cli "$SRC" --home "$OSRC_HOME" --host 192.168.1.5 --port 0 >/dev/null 2>&1 && bad "a LAN address must be refused" || ok "refuses a LAN address"

# --- token file ------------------------------------------------------------------------------------------------
url="$(python3 "$SRV" --cli "$SRC" --home "$OSRC_HOME" --port 18555 --print-url)"
TF="$OSRC_HOME/dash/token"
[ -f "$TF" ] && ok "first start creates the token file" || bad "no token file"
mode="$(stat -c %a "$TF" 2>/dev/null || stat -f %Lp "$TF")"
[ "$mode" = 600 ] && ok "token file is 0600" || bad "token mode $mode"
dmode="$(stat -c %a "$OSRC_HOME/dash" 2>/dev/null || stat -f %Lp "$OSRC_HOME/dash")"
[ "$dmode" = 700 ] && ok "token dir is 0700" || bad "token dir mode $dmode"
TOK="$(cat "$TF")"
[ "${#TOK}" -ge 32 ] && ok "token is long and random" || bad "short token"
[ "$url" = "http://127.0.0.1:18555/?token=$TOK" ] && ok "--print-url prints the loopback sign-in URL" || bad "url: $url"
python3 "$SRV" --cli "$SRC" --home "$OSRC_HOME" --port 18555 --print-url >/dev/null
[ "$(cat "$TF")" = "$TOK" ] && ok "the token survives restarts" || bad "token changed on restart"
chmod 644 "$TF"; python3 "$SRV" --cli "$SRC" --home "$OSRC_HOME" --port 18555 --print-url >/dev/null
mode="$(stat -c %a "$TF" 2>/dev/null || stat -f %Lp "$TF")"
[ "$mode" = 600 ] && ok "a loosened token file is tightened back to 0600" || bad "mode after restart $mode"

# --- serving ----------------------------------------------------------------------------------------------------
LOG="$TMP/server.log"
python3 "$SRV" --cli "$SRC" --home "$OSRC_HOME" --port 0 > "$LOG" 2>"$TMP/server.err" & PID=$!
for _ in $(seq 1 50); do grep -q 'dash: open' "$LOG" 2>/dev/null && break; sleep 0.1; done
PORT="$(sed -n 's#^dash: open http://127.0.0.1:\([0-9]*\)/.*#\1#p' "$LOG")"
[ -n "$PORT" ] && ok "serves on an ephemeral loopback port ($PORT)" || { bad "server did not start: $(cat "$TMP/server.err")"; echo "RESULT: $pass passed, $fail failed"; exit 1; }
B="http://127.0.0.1:$PORT"
code() { curl -s -o "$TMP/body" -w '%{http_code}' "$@"; }
A=(-H "Authorization: Bearer $TOK")

[ "$(code "$B/api/mode")" = 401 ] && ok "no token -> 401" || bad "no token was not refused"
[ "$(code -H "Authorization: Bearer nope" "$B/api/mode")" = 401 ] && ok "wrong token -> 401" || bad "wrong token was not refused"
[ "$(code -H "Cookie: osrc_dash=nope" "$B/api/mode")" = 401 ] && ok "wrong cookie -> 401" || bad "wrong cookie was not refused"
[ "$(code "${A[@]}" -H "Host: evil.example:$PORT" "$B/api/mode")" = 403 ] && ok "foreign Host header -> 403 (DNS rebinding)" || bad "foreign Host was not refused"
[ "$(code "${A[@]}" -H "Host: localhost:$PORT" "$B/api/mode")" = 200 ] && ok "Host localhost:<port> is accepted" || bad "localhost Host refused"

c="$(curl -s -D - -o /dev/null "$B/?token=$TOK")"
printf '%s' "$c" | grep -qi '^location: /\s*$' && ok "/?token= redirects to / (token leaves the URL)" || bad "no redirect: $c"
printf '%s' "$c" | grep -qi "^set-cookie: osrc_dash=$TOK; HttpOnly; SameSite=Strict" && ok "sets an HttpOnly SameSite=Strict cookie" || bad "cookie: $c"
[ "$(code "$B/?token=nope")" = 401 ] && ok "a wrong ?token= is refused" || bad "wrong ?token= accepted"
[ "$(code -H "Cookie: osrc_dash=$TOK" "$B/api/mode")" = 200 ] && ok "the cookie authenticates" || bad "cookie auth failed"

# passthrough: the API returns exactly the CLI's JSON
want="$(OSRC_HOME="$OSRC_HOME" bash "$SRC" mode status --json 2>/dev/null | jq -cS .)"
got="$(curl -s "${A[@]}" "$B/api/mode" | jq -cS .)"
[ -n "$want" ] && [ "$want" = "$got" ] && ok "GET /api/mode is exactly 'mode status --json'" || bad "passthrough: want=$want got=$got"
want="$(OSRC_HOME="$OSRC_HOME" bash "$SRC" outcomes --days 30 --json 2>/dev/null | jq -cS .)"
got="$(curl -s "${A[@]}" "$B/api/outcomes?days=30" | jq -cS .)"
[ "$want" = "$got" ] && ok "query parameters reach the CLI (outcomes --days 30)" || bad "outcomes passthrough"
[ "$(code "${A[@]}" "$B/api/heartbeat")" = 200 ] && jq -e '.armed == false' "$TMP/body" >/dev/null && ok "a CLI that exits 1 but prints JSON still passes through" || bad "heartbeat passthrough"

[ "$(code "${A[@]}" "$B/api/nope")" = 404 ] && jq -e '.endpoints | index("inbox")' "$TMP/body" >/dev/null && ok "unknown endpoint -> 404 listing the allow-list" || bad "unknown endpoint"
[ "$(code "${A[@]}" "$B/api/outcomes?days=abc")" = 400 ] && ok "bad query parameter -> 400" || bad "bad days accepted"
[ "$(code "${A[@]}" "$B/api/job/..%2F..%2Fetc")" = 400 ] && ok "path-like job id -> 400" || bad "path-like id accepted"
[ "$(code "${A[@]}" "$B/api/job/-rf")" = 400 ] && ok "option-like job id -> 400" || bad "option-like id accepted"
[ "$(code "${A[@]}" "$B/api/mode/extra")" = 400 ] && ok "a parameter on a fixed endpoint -> 400" || bad "extra path accepted"
[ "$(code "${A[@]}" "$B/api/estimate")" = 400 ] && ok "estimate without a task -> 400" || bad "empty estimate accepted"

# a job the CLI knows, through the id endpoints
jd="$OSRC_HOME/jobs/j-dash"; mkdir -p "$jd"; printf 'done\n' > "$jd/status"; printf '0\n' > "$jd/exit"
printf '{"id":"j-dash","provider":"codex","verb":"run","model":"gpt-5.6-sol","started":1700000000}\n' > "$jd/meta.json"
printf 'OSRC::PROGRESS 1/1 token=abcd1234efgh5678\nOSRC::DONE\n' > "$jd/out.log"
[ "$(code "${A[@]}" "$B/api/job/j-dash")" = 200 ] && jq -e '.job_id == "j-dash"' "$TMP/body" >/dev/null && ok "GET /api/job/<id> is status <id> --json" || bad "job endpoint: $(cat "$TMP/body")"
[ "$(code "${A[@]}" "$B/api/logs/j-dash")" = 200 ] && ! grep -q 'abcd1234efgh5678' "$TMP/body" && ok "GET /api/logs/<id> is the masked tail" || bad "logs endpoint leaked or failed: $(cat "$TMP/body")"
[ "$(code "${A[@]}" "$B/api/job/no-such-job")" != 200 ] && ok "an unknown job is not a 200" || bad "unknown job returned 200"

# methods and static files
[ "$(code -X POST "${A[@]}" "$B/api/mode")" = 405 ] && ok "POST -> 405 (read-only)" || bad "POST not refused"
[ "$(code -X DELETE "${A[@]}" "$B/api/mode")" = 405 ] && ok "DELETE -> 405" || bad "DELETE not refused"
h="$(curl -s -D - -o "$TMP/body" "${A[@]}" "$B/")"
grep -q 'Outsourcerer' "$TMP/body" && ok "serves the page" || bad "no page"
printf '%s' "$h" | grep -qi "^content-security-policy: default-src 'self'; script-src 'self'" && ok "strict CSP header" || bad "CSP: $h"
printf '%s' "$h" | grep -qi '^x-content-type-options: nosniff' && ok "nosniff header" || bad "no nosniff"
[ "$(code "${A[@]}" "$B/app.js")" = 200 ] && ok "serves app.js" || bad "app.js"
[ "$(code "${A[@]}" "$B/../server.py")" = 404 ] && [ "$(code "${A[@]}" "$B/server.py")" = 404 ] && ok "only static assets are served" || bad "served a non-static file"
[ "$(code "$B/app.js")" = 401 ] && ok "static files need the token too" || bad "static without token"

# the request log never prints the token
curl -s "$B/?token=$TOK" >/dev/null
grep -q "$TOK" "$TMP/server.err" && bad "the token appeared in the request log" || ok "the request log never prints the token"

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
