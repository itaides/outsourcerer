#!/usr/bin/env bash
# test_inbox.sh — `inbox [--json]`, the Needs you triage. Part 1 drives the triage program (_INBOX_JQ)
# with fixture inputs: kinds, severity, one primary action per row, dedupe, ordering, the unknown list.
# Part 2 runs the command end to end over fixture job dirs, a held plan task and an obligations file,
# with the fleet snapshot stubbed. Offline; never touches the real ~/.outsourcerer or ~/.claude.
#
# Run: bash test_inbox.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../outsourcerer.sh"
[ -f "$SRC" ] || { echo "FAIL: cannot find $SRC"; exit 1; }
bash -n "$SRC" || { echo "FAIL: bash -n failed for $SRC"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required for this test"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/osrc-inbox.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"; mkdir -p "$HOME"
export OSRC_HOME="$TMP/state"; mkdir -p "$OSRC_HOME/jobs"
export OSRC_SOURCED=1 OSRC_FLEET_SUPERVISION=0 OSRC_HEARTBEAT_DISABLED=1 OSRC_BLIND_TURN_GUARD=0
. "$SRC" >/dev/null 2>&1
for f in cmd_inbox _inbox_inputs; do type -t "$f" >/dev/null || { echo "FAIL: $f not loaded"; exit 1; }; done
[ -n "${_INBOX_JQ:-}" ] || { echo "FAIL: _INBOX_JQ not set"; exit 1; }

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
triage() { printf '%s' "$1" | jq -c "$_INBOX_JQ"; }

NOW=1800000000
iso() { jq -rn --argjson t "$1" '$t | todate'; }

# ---------------------------------------------------------------------------------------------------------
# Part 1: the triage program
# ---------------------------------------------------------------------------------------------------------
empty='{"now":1800000000,"window_s":86400,"sessions":[],"jobs":[],"tasks":[],"obligations":[]}'
check "empty inputs: nothing needs you" "$(triage "$empty")" '.items == [] and .unknown == [] and .counts == {items:0, red:0, amber:0, unknown:0}'

job() { # <id> <status> <age> [model] [observed] [marker] [supervision] [line]
  jq -cn --arg id "$1" --arg st "$2" --argjson age "$3" --arg m "${4:-gpt-5.6-sol}" --arg o "${5:-}" --arg mk "${6:-}" --arg sup "${7:-}" --arg ln "${8:-}" \
    '{job_id:$id, status:$st, status_age:$age, model:$m, observed_model:(if $o=="" then null else $o end), provider:"codex", verb:"edit",
      label:("task " + $id), cwd:"/r/event-planner", supervision:(if $sup=="" then null else $sup end),
      progress:{last_marker:(if $mk=="" then null else $mk end), line:(if $ln=="" then null else $ln end)}}'
}
jobs="[$(job j-perm permission-blocked 600 '' '' '' '' 'git index lock denied'),$(job j-old permission-blocked 999999),$(job j-ask blocked 60 '' '' OSRC::NEED_INPUT),$(job j-drift running 30 opus claude-sonnet-4-6),$(job j-same running 30 opus claude-opus-4-7),$(job j-stuck no-progress-writes 540),$(job j-unw running 120 '' '' '' not-armed),$(job j-ok running 10),$(job j-done done 5)]"
in="$(jq -cn --argjson j "$jobs" --argjson base "$empty" '$base + {jobs:$j}')"
out="$(triage "$in")"
kinds="$(printf '%s' "$out" | jq -c '[.items[] | {(.refs.job_id): .kind}] | add')"
check "jobs: each problem becomes its kind" "$out" '([.items[] | {(.refs.job_id): .kind}] | add) == {"j-perm":"permission","j-ask":"waiting_on_you","j-drift":"model_drift","j-stuck":"maybe_stuck","j-unw":"unwatched"}'
check "jobs: a stopped job older than the window drops out" "$out" 'all(.items[]; .refs.job_id != "j-old")'
check "jobs: observed model that contains the requested name is not drift" "$out" 'all(.items[]; .refs.job_id != "j-same")'
check "jobs: healthy and finished jobs are not listed" "$out" 'all(.items[]; .refs.job_id != "j-ok" and .refs.job_id != "j-done")'
check "every row has exactly one primary action with an argv" "$out" 'all(.items[]; (.primary_action.argv | type) == "array" and (.primary_action.argv[0] == "outsourcerer") and (.primary_action.label | length) > 0)'
check "actions are the existing commands" "$out" '(.items[] | select(.kind=="permission") | .primary_action.argv) == ["outsourcerer","explain","j-perm"]
  and (.items[] | select(.kind=="model_drift") | .secondary_action.argv) == ["outsourcerer","cancel","j-drift"]
  and (.items[] | select(.kind=="unwatched") | .primary_action.argv) == ["outsourcerer","heartbeat","start"]'
check "drift reason names both models" "$out" '(.items[] | select(.kind=="model_drift") | .reason) == "Asked for opus, the lane reported claude-sonnet-4-6"'
check "permission reason carries the last progress line" "$out" '(.items[] | select(.kind=="permission") | .reason) | endswith("git index lock denied")'
check "red rows first, then the longest wait" "$out" '(.items | map(.severity)) == ["red","red","amber","amber","amber"] and (.items[0].refs.job_id == "j-perm") and (.items[2].refs.job_id == "j-stuck")'
check "repo is the cwd basename" "$out" 'all(.items[]; .repo == "event-planner")'
check "counts add up" "$out" '.counts == {items:5, red:2, amber:3, unknown:0}'

sess() { # <id> <state> <age> [requested] [observed] [self] [owner]
  jq -cn --arg id "$1" --arg st "$2" --argjson age "$3" --arg r "${4:-}" --arg o "${5:-}" --argjson self "${6:-0}" --arg own "${7:-cc-peer}" \
    '{session_id:$id, state:$st, status_age:$age, requested_model:(if $r=="" then null else $r end), observed_model:(if $o=="" then null else $o end),
      self:$self, owner:$own, harness:"cc", cwd:"/r/ora", task_summary:("session " + $id), state_evidence:"CC status=waiting: approve Bash?"}'
}
sessions="[$(sess s-wait 'blocked?' 300),$(sess s-blk blocked 50),$(sess s-slow 'unresponsive?' 700),$(sess s-drift working 20 opus sonnet),$(sess s-self 'blocked?' 10 '' '' 1),$(sess s-mgd 'blocked?' 10 '' '' 0 managed),$(sess s-unk unknown 9000),$(sess s-fine working 5)]"
in="$(jq -cn --argjson s "$sessions" --argjson base "$empty" '$base + {sessions:$s}')"
out="$(triage "$in")"
check "sessions: each problem becomes its kind" "$out" '([.items[] | {(.refs.session_id): .kind}] | add) == {"s-wait":"waiting_on_you","s-blk":"blocked","s-slow":"maybe_stuck","s-drift":"model_drift"}'
check "sessions: this session and managed jobs are skipped" "$out" 'all(.items[]; .refs.session_id != "s-self" and .refs.session_id != "s-mgd")'
check "sessions: unknown state goes to the unknown list, not items" "$out" '.unknown == [{session_id:"s-unk", title:"session s-unk", repo:"ora", lane:"cc", last_seen_s:9000}] and .counts.unknown == 1'
check "sessions: a waiting session can be replied to (your text)" "$out" '(.items[] | select(.refs.session_id=="s-wait") | .secondary_action) == {label:"Reply", argv:["outsourcerer","session","reply","s-wait","{answer}"], input:"answer"}'
check "sessions: action opens the session" "$out" '(.items[] | select(.refs.session_id=="s-wait") | .primary_action.argv) == ["outsourcerer","fleet","show","s-wait"]'

task='{"id":"t4","plan":"rate-limit","repo":"/r/ora","title":"counter store","state":"held","updated":"'"$(iso $((NOW-1560)))"'","hold":{"reason":"Postgres or SQLite?","until":"x","until_epoch":'"$((NOW+6120))"',"default":"SQLite","answer":""}}'
task2='{"id":"t5","plan":"rate-limit","repo":"/r/ora","title":"name it","state":"held","updated":"bad-date","hold":{"reason":"What name?"}}'
in="$(jq -cn --argjson t "[$task,$task2]" --argjson base "$empty" '$base + {tasks:$t}')"
out="$(triage "$in")"
check "decision: question, default, deadline, wait" "$out" '(.items[] | select(.refs.task=="t4")) | .kind == "decision" and .title == "Postgres or SQLite?" and .default == "SQLite" and .deadline_s == 6120 and .waiting_s == 1560 and .repo == "ora"'
check "decision: Answer needs your text, the default is one click" "$out" '(.items[] | select(.refs.task=="t4")) | .primary_action == {label:"Answer", argv:["outsourcerer","task","release","t4","--plan","rate-limit","--answer","{answer}"], input:"answer"}
  and .secondary_action.argv == ["outsourcerer","task","release","t4","--plan","rate-limit","--answer","SQLite"]'
check "decision: no default -> no secondary, no deadline, bad date -> 0 wait" "$out" '(.items[] | select(.refs.task=="t5")) | (has("secondary_action") | not) and .deadline_s == null and .default == null and .waiting_s == 0'

obl() { jq -cn --arg id "$1" --arg s "$2" --arg st "$3" --arg ts "$(iso "$4")" '{obligation_id:$id, session_id:$s, state:$st, ts:$ts}'; }
in="$(jq -cn --argjson o "[$(obl o1 s-x delivery_unknown $((NOW-540))),$(obl o2 s-y delivered $((NOW-60))),$(obl o3 s-gone delivery_unknown $((NOW-999999))),$(obl o4 s-live delivery_unknown $((NOW-999999)))]" \
  --argjson s "[$(sess s-live working 5)]" --argjson base "$empty" '$base + {obligations:$o, sessions:$s}')"
out="$(triage "$in")"
check "not delivered: recent unknown delivery is listed" "$out" 'any(.items[]; .kind == "not_delivered" and .refs.obligation_id == "o1" and .waiting_s == 540)'
check "not delivered: delivered messages are not" "$out" 'all(.items[]; .refs.obligation_id != "o2")'
check "not delivered: old and the session is gone -> dropped" "$out" 'all(.items[]; .refs.obligation_id != "o3")'
check "not delivered: old but the session is still live -> kept" "$out" 'any(.items[]; .refs.obligation_id == "o4")'

# dedupe: a session that is waiting AND has an undelivered message is one row, the more severe kind
in="$(jq -cn --argjson s "[$(sess s-dup blocked 100)]" --argjson o "[$(obl o9 s-dup delivery_unknown $((NOW-30)))]" --argjson base "$empty" '$base + {sessions:$s, obligations:$o}')"
out="$(triage "$in")"
check "dedupe: one row per session, the most severe wins" "$out" '(.items | length) == 1 and .items[0].kind == "blocked"'

# ---------------------------------------------------------------------------------------------------------
# Part 2: end to end over fixture state, fleet snapshot stubbed
# ---------------------------------------------------------------------------------------------------------
_fleet_snapshot_refresh() { jq -cn --argjson s "[$(sess s-wait 'blocked?' 300)]" '{schema_version:"1", items:$s}'; }
jd="$OSRC_JOBS/j-e2e"; mkdir -p "$jd"
printf 'permission-blocked\n' > "$jd/status"; printf '3\n' > "$jd/exit"
printf '{"id":"j-e2e","provider":"devin","verb":"edit","model":"swe-2-high","cwd":"/r/event-planner","started":1700000000}\n' > "$jd/meta.json"
printf 'OSRC::PROGRESS 2/3 export API_KEY=supersecretvalue123\n' > "$jd/out.log"
mkdir -p "$OSRC_HOME/plans/rl/tasks"
printf '{"schema":1,"name":"rl","goal":"g","repo":"/r/ora","base_branch":"main"}\n' > "$OSRC_HOME/plans/rl/plan.json"
printf '%s\n' "$task" | jq -c '.plan = "rl" | .updated = (now | todate)' > "$OSRC_HOME/plans/rl/tasks/t4.json"
printf '{"id":"t1","state":"done","title":"x"}\n' > "$OSRC_HOME/plans/rl/tasks/t1.json"
obl o1 s-x delivery_unknown "$(( $(date +%s) - 30 ))" > "$OSRC_OBLIGATIONS"
obl o1 s-x delivered "$(( $(date +%s) - 10 ))" >> "$OSRC_OBLIGATIONS"

out="$(cmd_inbox --json)"
check "e2e: job, session and held task, latest obligation state wins" "$out" '([.items[].kind] | sort) == ["decision","permission","waiting_on_you"]'
check "e2e: secrets in a progress line stay redacted" "$out" '(tostring | contains("supersecretvalue123")) | not'
check "e2e: held task carries its plan and repo" "$out" '(.items[] | select(.kind=="decision")) | .refs == {plan:"rl", task:"t4"} and .repo == "ora"'
touch -t 202001010000 "$jd/status"   # stopped long ago
out="$(OSRC_INBOX_WINDOW_S=60 cmd_inbox --json)"
check "e2e: a job stopped before the window is hidden" "$out" 'all(.items[]; .kind != "permission")'
( OSRC_INBOX_WINDOW_S=abc cmd_inbox --json >/dev/null 2>&1 ) && bad "a bad window must be refused" || ok "bad OSRC_INBOX_WINDOW_S refused"
( cmd_inbox --bogus >/dev/null 2>&1 ) && bad "unknown flags must be refused" || ok "unknown flags refused"
touch "$jd/status"   # fresh again for the text checks
txt="$(cmd_inbox)"
printf '%s\n' "$txt" | grep '^3 need you (1 blocking):' >/dev/null && ok "text header" || bad "text header: $txt"
printf '%s\n' "$txt" | grep -- '-> Explain: outsourcerer explain j-e2e' >/dev/null && ok "text shows the exact command" || bad "text action: $txt"
_fleet_snapshot_refresh() { printf '{"schema_version":"1","items":[]}'; }
rm -rf "$OSRC_JOBS"/* "$OSRC_HOME/plans"; : > "$OSRC_OBLIGATIONS"
[ "$(cmd_inbox)" = "Nothing needs you." ] && ok "empty text state" || bad "empty text: $(cmd_inbox)"

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
