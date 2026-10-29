#!/usr/bin/env bash
# test_more_json.sh — the remaining --json forms a dashboard reads: posture status, tap status, plan ls,
# flow ls, land queue and doctor. Fixture state only (an empty HOME and OSRC_HOME, a throwaway repo,
# lane probes stubbed for doctor), so this runs offline and never touches the real ~/.outsourcerer.
#
# Run: bash test_more_json.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../outsourcerer.sh"
[ -f "$SRC" ] || { echo "FAIL: cannot find $SRC"; exit 1; }
bash -n "$SRC" || { echo "FAIL: bash -n failed for $SRC"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required for this test"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "FAIL: git is required for this test"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/osrc-morejson.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
export GIT_CEILING_DIRECTORIES="$(dirname "$TMP")"
export HOME="$TMP/home"; mkdir -p "$HOME"
export OSRC_HOME="$TMP/state"; mkdir -p "$OSRC_HOME"
export OSRC_FLEET_SUPERVISION=0 OSRC_HEARTBEAT_DISABLED=1 OSRC_BLIND_TURN_GUARD=0
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
O() { bash "$SRC" "$@"; }

pass=0; fail=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }
check() {
  local label="$1" out="$2" filter="$3" lines
  lines="$(printf '%s\n' "$out" | grep -c '^')"
  if [ "$lines" != "1" ]; then bad "$label: expected one line of output, got $lines: $out"; return; fi
  if printf '%s' "$out" | jq -e "(.schema_version == \"1\") and ($filter)" >/dev/null 2>&1; then ok "$label"
  else bad "$label: $filter  <-  $out"; fi
}

# --- posture status --json ------------------------------------------------------------------------------
check "posture: none remembered" "$(O posture status --json)" '.postures == []'
mkdir -p "$OSRC_HOME/lane-posture"
printf 'refused\n' > "$OSRC_HOME/lane-posture/dv.yolo"
printf '%s\n' "$(( $(date +%s) + 3600 ))" > "$OSRC_HOME/lane-posture/grokbot.down"
out="$(O posture status --json)"
check "posture: one entry per file" "$out" '(.postures | length) == 2 and any(.postures[]; .lane == "dv" and .key == "yolo" and .value == "refused")'
check "posture --json is the same as posture status --json" "$(O posture --json)" '(.postures | length) == 2'
O posture status | grep 'dv.yolo = refused' >/dev/null && ok "posture text unchanged" || bad "posture text changed"

# --- tap status --json -----------------------------------------------------------------------------------
check "tap: not installed, not capturing" "$(O tap status --json)" '.installed == false and .capturing == false and .reading_age_s == null and .five_hour == null'
mkdir -p "$HOME/.claude"
printf '{"statusLine":{"type":"command","command":"bash /x/outsourcerer.sh tap run"}}\n' > "$HOME/.claude/settings.json"
printf '{"five_hour":{"used_percentage":62},"seven_day":{"used_percentage":41},"timestamp":%s000,"source":"outsourcerer-tap"}\n' "$(( $(date +%s) - 120 ))" > "$OSRC_HOME/rate-limits.json"
out="$(O tap status --json)"
check "tap: installed and capturing, with reading age" "$out" '.installed == true and .capturing == true and .reading_age_s >= 120 and .reading_age_s < 200 and .five_hour.used_percentage == 62'
check "tap --json is tap status --json" "$(O tap --json)" '.installed == true'

# --- plan ls --json ----------------------------------------------------------------------------------------
check "plan ls: no plans" "$(O plan ls --json)" '.plans == [] and .current == null'
REPO="$TMP/repo"; mkdir -p "$REPO"; git -C "$REPO" init -q -b main; echo a > "$REPO/a"; git -C "$REPO" add a; git -C "$REPO" commit -qm init
( cd "$REPO" && O plan new alpha --goal 'ship the thing' >/dev/null 2>&1 )
( cd "$REPO" && O task add 'scout auth' --prompt 'map it' >/dev/null 2>&1 )
( cd "$REPO" && O task add 'build login' --shape ship --deps t1 --check 'make test' >/dev/null 2>&1 )
( cd "$TMP" && O plan new beta --no-repo --no-use >/dev/null 2>&1 )
out="$(O plan ls --json)"
check "plan ls: both plans, current marked" "$out" '(.plans | length) == 2 and .current == "alpha" and (.plans[] | select(.name=="alpha") | .current and .goal == "ship the thing" and .tasks == 2)'
check "plan ls: counts per derived state" "$out" '(.plans[] | select(.name=="alpha") | .counts | (to_entries | map(.value) | add)) == 2'
check "plan ls: a plan with no tasks" "$out" '(.plans[] | select(.name=="beta") | .tasks == 0 and .counts == {} and .current == false)'
O plan ls | grep 'ship the thing' >/dev/null && ok "plan ls text unchanged" || bad "plan ls text changed"
( O plan ls --bogus >/dev/null 2>&1 ) && bad "plan ls must refuse unknown options" || ok "plan ls refuses unknown options"

# --- flow ls --json ----------------------------------------------------------------------------------------
out="$(O flow ls --json)"
check "flow ls: built-in flows listed" "$out" '(.flows | length) >= 3 and any(.flows[]; .name == "council-build" and .source == "built-in" and (.stages > 0))'
mkdir -p "$OSRC_HOME/flows"; printf '{"name":"council-build","description":"mine","stages":[{"id":"a"}]}\n' > "$OSRC_HOME/flows/council-build.json"
out="$(O flow ls --json)"
check "flow ls: your flow overrides the built-in by name" "$out" '[.flows[] | select(.name == "council-build")] | length == 1 and .[0].source == "yours" and .[0].description == "mine"'
O flow ls | grep 'council-build' >/dev/null && ok "flow ls text unchanged" || bad "flow ls text changed"

# --- land queue --json ---------------------------------------------------------------------------------------
check "land queue: nothing waiting" "$(O land queue --json)" '.waiting == [] and .merging == []'
td="$OSRC_HOME/plans/alpha/tasks"
jq '.state = "done" | .branch = "osrc/t2" | .updated = "2026-10-29T08:00:00Z" | .evidence = {check:{cmd:"make test", rc:0}, verdict:"done"}' "$td/t2.json" > "$td/t2.json.n" && mv "$td/t2.json.n" "$td/t2.json"
jq '.id = "t3" | .title = "landed one" | .landed = true' "$td/t2.json" > "$td/t3.json"
jq '.id = "t4" | .title = "no check" | .updated = "2026-10-29T07:00:00Z" | del(.evidence)' "$td/t2.json" > "$td/t4.json"
mkdir -p "$OSRC_HOME/locks/land-123"; printf '4242 x\n' > "$OSRC_HOME/locks/land-123/owner"; printf 'alpha/t9 (since now)\n' > "$OSRC_HOME/locks/land-123/holder"
out="$(O land queue --json)"
check "land queue: done ship tasks not landed, oldest first" "$out" '(.waiting | map(.task)) == ["t4", "t2"]'
check "land queue: check and branch carried" "$out" '(.waiting[] | select(.task=="t2")) | .check == {cmd:"make test", rc:0} and .branch == "osrc/t2" and .into == "main"'
check "land queue: no check -> check null" "$out" '(.waiting[] | select(.task=="t4")) .check == null'
check "land queue: the lock holder is merging" "$out" '.merging == [{lock:"land-123", holder:"alpha/t9 (since now)", pid:4242}]'
txt="$(O land queue)"
printf '%s\n' "$txt" | grep 'no check recorded: lands as unverified' >/dev/null && ok "land queue text names unverified lands" || bad "land queue text: $txt"
( O land queue --bogus >/dev/null 2>&1 ) && bad "land queue must refuse unknown options" || ok "land queue refuses unknown options"

# --- doctor --json (lane probes stubbed) ---------------------------------------------------------------------
DLIB="$TMP/doctor.sh"
cat > "$DLIB" <<EOF
OSRC_SOURCED=1 . "$SRC" >/dev/null 2>&1
_lane_ready_probe() { case "\$1" in cx) printf 'codex=sol/terra' ;; local) printf 'local=ollama' ;; *) return 1 ;; esac; }
have() { case "\$1" in codex) return 0 ;; devin|droid|cursor|hermes|oz|cline|pi) return 1 ;; *) command -v "\$1" >/dev/null 2>&1 ;; esac; }
EOF
out="$(bash -c ". '$DLIB'; doctor --json")"
check "doctor --json: every registered lane" "$out" '(.lanes | length) == (.summary.lanes) and (.lanes | length) >= 15'
check "doctor --json: probe verdicts" "$out" '(.lanes[] | select(.lane=="cx")) | .installed == true and .ready == true and .detail == "sol/terra" and .plan_limited == true and .is_cloud == true'
check "doctor --json: not installed is false, not ready" "$out" '(.lanes[] | select(.lane=="droid")) | .installed == false and .ready == false'
check "doctor --json: a lane with no CLI of its own has installed null" "$out" '(.lanes[] | select(.lane=="local")) | .installed == null and .ready == true'
check "doctor --json: lane-down mark and postures" "$out" '(.lanes[] | select(.lane=="grokbot")) | .down == true and (.postures | map(.key) | index("down") != null)'
check "doctor --json: state home writable" "$out" '.state_home.writable == true and .summary.ready == 2 and .summary.down == 1'
dtxt="$(bash -c ". '$DLIB'; OSRC_DOCTOR_OFFLINE=1 doctor" 2>/dev/null)"   # doctor exits non-zero when lanes are down; only the text matters here
printf '%s\n' "$dtxt" | grep '^== outsourcerer doctor' >/dev/null && ok "doctor text unchanged" || bad "doctor text header missing"

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
