#!/usr/bin/env bash
# test_dash_actions.sh — POST /api/run, the dashboard's only write path: token + X-Osrc-Dash header +
# JSON body required, the argv must match an ACTIONS shape exactly (fixed words, validated values), it
# runs with no shell, its output is redacted, and the read cache is cleared so the change shows at once.
# Fixture state, offline.
#
# Run: bash test_dash_actions.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../outsourcerer.sh"
SRV="$HERE/../dashboard/server.py"
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed"; exit 0; }
command -v curl >/dev/null 2>&1 || { echo "SKIP: curl not installed"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required for this test"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/osrc-dashact.XXXXXX")"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; wait 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
export HOME="$TMP/home"; mkdir -p "$HOME"
export OSRC_HOME="$TMP/state"; mkdir -p "$OSRC_HOME/jobs"
export OSRC_FLEET_SUPERVISION=0 OSRC_HEARTBEAT_DISABLED=1 OSRC_BLIND_TURN_GUARD=0

pass=0; fail=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }

LOG="$TMP/server.log"
OSRC_DASH_NO_WARM=1 python3 "$SRV" --cli "$SRC" --home "$OSRC_HOME" --port 0 > "$LOG" 2>"$TMP/server.err" & PID=$!   # no warm-up: this test changes state from the CLI too
for _ in $(seq 1 300); do grep -q 'dash: open' "$LOG" 2>/dev/null && break; sleep 0.1; done   # up to 30 s: a loaded CI runner starts it slowly
PORT="$(sed -n 's#^dash: open http://127.0.0.1:\([0-9]*\)/.*#\1#p' "$LOG")"
[ -n "$PORT" ] || { echo "FAIL: server did not start: $(cat "$TMP/server.err")"; exit 1; }
TOK="$(cat "$OSRC_HOME/dash/token")"
B="http://127.0.0.1:$PORT"
post() { # <json-body> [extra curl args...] -> http code; body in $TMP/body
  local body="$1"; shift
  curl -s -o "$TMP/body" -w '%{http_code}' -X POST -H "Authorization: Bearer $TOK" -H "X-Osrc-Dash: 1" \
    -H "Content-Type: application/json" --data "$body" "$@" "$B/api/run"
}

# --- the gate --------------------------------------------------------------------------------------------
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Osrc-Dash: 1" -H "Content-Type: application/json" --data '{"argv":["mode","hybrid"]}' "$B/api/run")" = 401 ] \
  && ok "no token -> 401" || bad "POST without token accepted"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" --data '{"argv":["mode","hybrid"]}' "$B/api/run")" = 403 ] \
  && ok "no X-Osrc-Dash header -> 403 (a cross-site form cannot set it)" || bad "missing header accepted"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOK" -H "X-Osrc-Dash: 1" -H "Content-Type: text/plain" --data '{"argv":["mode","hybrid"]}' "$B/api/run")" = 403 ] \
  && ok "non-JSON content type -> 403" || bad "text/plain accepted"
[ "$(post '{"argv":["mode","hybrid"]}' -H "Host: evil.example:$PORT")" = 403 ] && ok "foreign Host -> 403" || bad "foreign Host accepted"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOK" -H "X-Osrc-Dash: 1" -H "Content-Type: application/json" --data '{"argv":["mode","hybrid"]}' "$B/api/other")" = 404 ] \
  && ok "only /api/run takes POST" || bad "POST to another path"
[ "$(post 'not json')" = 400 ] && ok "malformed body -> 400" || bad "malformed body"
big="$(head -c 20000 /dev/zero | tr '\0' a)"
c="$(post "{\"argv\":[\"task\",\"release\",\"t1\",\"--plan\",\"p\",\"--answer\",\"$big\"]}" 2>/dev/null)"
[ "$c" = 400 ] && ok "oversized body -> 400" || bad "oversized body: $c"

# --- the allow-list ----------------------------------------------------------------------------------------
for argv in '["mode","yolo"]' '["mode","hybrid","x"]' '["yolo","rm -rf /"]' '["cancel","--all"]' \
            '["cancel","../x"]' '["exclude","add","-m"]' '["task","release","t1","--plan","p"]' '["task","release","x1","--plan","p","--answer","a"]' \
            '["gc","--older-than","0"]' '["mode",1]' '"mode hybrid"' '[]'; do
  [ "$(post "{\"argv\":$argv}")" = 403 ] && ok "refused: $argv" || bad "allowed: $argv -> $(cat "$TMP/body")"
done

# --- allowed actions run, and reads see the change at once --------------------------------------------------
OSRC_HOME="$OSRC_HOME" bash "$SRC" mode auto >/dev/null 2>&1
[ "$(curl -s -H "Authorization: Bearer $TOK" "$B/api/mode" | jq -r .mode)" = auto ] && ok "starts in auto mode" || bad "initial mode"
[ "$(post '{"argv":["outsourcerer","mode","hybrid"]}')" = 200 ] && jq -e '.ok and .exit == 0 and .command == ["outsourcerer","mode","hybrid"]' "$TMP/body" >/dev/null \
  && ok "mode hybrid runs (a leading \"outsourcerer\" is accepted)" || bad "mode hybrid: $(cat "$TMP/body")"
[ "$(OSRC_HOME="$OSRC_HOME" bash "$SRC" mode status --json | jq -r .mode)" = hybrid ] && ok "the CLI sees the new mode" || bad "mode not persisted"
[ "$(curl -s -H "Authorization: Bearer $TOK" "$B/api/mode" | jq -r .mode)" = hybrid ] && ok "the read cache was cleared" || bad "stale cached mode"

[ "$(post '{"argv":["exclude","add","glm-5.2"]}')" = 200 ] && jq -e .ok "$TMP/body" >/dev/null && ok "exclude add runs" || bad "exclude add: $(cat "$TMP/body")"
OSRC_HOME="$OSRC_HOME" bash "$SRC" exclude ls --json | jq -e '.entries | map(.entry) | index("glm-5.2")' >/dev/null && ok "the model is on the never-use list" || bad "exclude not saved"
post '{"argv":["exclude","rm","glm-5.2"]}' >/dev/null
OSRC_HOME="$OSRC_HOME" bash "$SRC" exclude ls --json | jq -e '.entries == []' >/dev/null && ok "exclude rm runs" || bad "exclude rm"

# a held decision answered from the page
mkdir -p "$OSRC_HOME/plans/rl/tasks"
printf '{"schema":1,"name":"rl","goal":"g","repo":"","base_branch":""}\n' > "$OSRC_HOME/plans/rl/plan.json"
printf '{"id":"t1","title":"pick a store","state":"held","shape":"scout","deps":[],"hold":{"reason":"Postgres or SQLite?","until":"","until_epoch":0,"default":"","answer":""}}\n' > "$OSRC_HOME/plans/rl/tasks/t1.json"
: > "$OSRC_HOME/plans/rl/events.jsonl"
[ "$(post '{"argv":["task","release","t1","--plan","rl","--answer","SQLite; drop table x"]}')" = 200 ] && jq -e .ok "$TMP/body" >/dev/null \
  && ok "task release runs with free-text answer" || bad "task release: $(cat "$TMP/body")"
jq -e '.hold.answer == "SQLite; drop table x" and .state != "held"' "$OSRC_HOME/plans/rl/tasks/t1.json" >/dev/null \
  && ok "the answer is stored verbatim (an argv element, never shell)" || bad "answer: $(cat "$OSRC_HOME/plans/rl/tasks/t1.json")"

# --- launching work and replying: the allow-list (checked in-process; no real lane is ever started here) ---
allow() { python3 - "$SRV" "$1" <<'PY'
import importlib.util, json, sys
sp = importlib.util.spec_from_file_location("srv", sys.argv[1]); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
print("yes" if m.action_allowed(json.loads(sys.argv[2])) else "no")
PY
}
# a duplicate key in the VALIDATORS literal silently replaces the first validator (it once let any
# string through as a plan task id), so the keys must be unique
python3 - "$SRV" <<'PY' && ok "VALIDATORS has no duplicate keys" || bad "VALIDATORS has a duplicate key"
import ast, sys
tree = ast.parse(open(sys.argv[1]).read())
for node in ast.walk(tree):
    if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "VALIDATORS" for t in node.targets):
        keys = [k.value for k in node.value.keys]
        sys.exit(0 if len(keys) == len(set(keys)) else 1)
sys.exit(1)
PY
[ "$(allow '["task","release","x1","--plan","p","--answer","a"]')" = no ] && ok "plan task ids still have to look like tN" || bad "task id validator was replaced"
for argv in '["bg","edit","fix the flaky tests"]' '["bg","run","-m","gpt-5.6-sol","map the auth module"]' '["bg","--worktree","yolo","-m","z-ai/glm-5.2","refactor x"]' \
            '["loop","verify","--check","npm test","--verb","edit","--max","4","--max-minutes","20","--worktree","--","make it pass"]' \
            '["loop","verify","-m","sol","--check","npx playwright test --retries=0","--verb","yolo","--max","3","--max-minutes","15","--","x"]' \
            '["session","reply","dec1a421-5e50-4c02-a675-595da44f531c","go on"]'; do
  [ "$(allow "$argv")" = yes ] && ok "allowed: $argv" || bad "refused: $argv"
done
for argv in '["bg","--cloud-ack","edit","x"]' '["bg","edit","--yolo"]' '["bg","edit","-rf x"]' '["bg","sudo","x"]' '["bg","edit","-m","-x","t"]' '["bg","edit","t","extra"]' \
            '["loop","verify","--check","npm test\nrm -rf /","--verb","edit","--max","4","--max-minutes","20","--","x"]' \
            '["loop","verify","--check","npm test","--verb","run","--max","4","--max-minutes","20","--","x"]' \
            '["loop","verify","--check","npm test","--verb","edit","--max","0","--max-minutes","20","--","x"]' \
            '["loop","verify","--check","npm test","--verb","edit","--max","4","--max-minutes","20","x"]' \
            '["session","reply","../x","hi"]' '["session","send","s1","hi"]'; do
  [ "$(allow "$argv")" = no ] && ok "refused: $argv" || bad "allowed: $argv"
done
# a loop starts detached; an immediate refusal (here: an excluded model) is reported, not hidden
OSRC_HOME="$OSRC_HOME" bash "$SRC" exclude add fable >/dev/null 2>&1
[ "$(post '{"argv":["loop","verify","-m","fable","--check","true","--verb","edit","--max","1","--max-minutes","1","--","x"]}')" = 200 ] \
  && jq -e '(.ok | not) and .exit != 0 and (.log | test("/dash/launches/loop-"))' "$TMP/body" >/dev/null \
  && ok "a refused loop launch reports its exit and log" || bad "loop launch: $(cat "$TMP/body")"
lf="$(jq -r .log "$TMP/body")"; m="$(stat -c %a "$lf" 2>/dev/null || stat -f %Lp "$lf")"
[ "$m" = 600 ] && ok "the launch log is private (0600)" || bad "launch log mode $m"
OSRC_HOME="$OSRC_HOME" bash "$SRC" exclude rm fable >/dev/null 2>&1
# replying to a session that does not exist fails visibly
[ "$(post '{"argv":["session","reply","no-such-session","hello"]}')" = 200 ] && jq -e '(.ok | not) and .exit != 0' "$TMP/body" >/dev/null \
  && ok "a reply to an unknown session reports its failure" || bad "reply: $(cat "$TMP/body")"

# posture reset clears remembered postures
mkdir -p "$OSRC_HOME/lane-posture"; printf 'refused\n' > "$OSRC_HOME/lane-posture/dv.yolo"
[ "$(post '{"argv":["posture","reset"]}')" = 200 ] && jq -e .ok "$TMP/body" >/dev/null && [ ! -e "$OSRC_HOME/lane-posture/dv.yolo" ] \
  && ok "posture reset runs" || bad "posture reset: $(cat "$TMP/body")"
[ "$(post '{"argv":["posture","reset","--all"]}')" = 403 ] && ok "refused: posture reset --all" || bad "posture reset --all allowed"

# a failing action is a 200 with ok:false and its exit code, not a server error
[ "$(post '{"argv":["cancel","no-such-job"]}')" = 200 ] && jq -e '(.ok | not) and .exit != 0' "$TMP/body" >/dev/null \
  && ok "a failing action reports its exit code" || bad "failing action: $(cat "$TMP/body")"

# output is redacted
jd="$OSRC_HOME/jobs/j-sec"; mkdir -p "$jd"; printf 'done\n' > "$jd/status"
printf '{"id":"j-sec","provider":"codex","verb":"run","model":"m","started":1700000000}\n' > "$jd/meta.json"
printf 'here is the key: sk-abcdef1234567890 and API_KEY=hunter2hunter2\n' > "$jd/last.txt"; : > "$jd/out.log"
[ "$(post '{"argv":["result","j-sec"]}')" = 200 ] && ! grep -q 'abcdef1234567890\|hunter2hunter2' "$TMP/body" && grep -q 'REDACTED' "$TMP/body" \
  && ok "action output is redacted" || bad "redaction: $(cat "$TMP/body")"

# no other write method
[ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $TOK" "$B/api/run")" = 405 ] && ok "PUT -> 405" || bad "PUT accepted"

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
