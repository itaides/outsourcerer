#!/usr/bin/env bash
# test_run_detail.sh — the run detail a dashboard drawer needs: the new `status --json` fields
# (progress line + history, observed model, watchdog windows, worktree, verify), `logs --masked`, and
# `loop status --json`. Fixture job and loop folders only, so this runs offline and never touches the
# real ~/.outsourcerer.
#
# Run: bash test_run_detail.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../outsourcerer.sh"
[ -f "$SRC" ] || { echo "FAIL: cannot find $SRC"; exit 1; }
bash -n "$SRC" || { echo "FAIL: bash -n failed for $SRC"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required for this test"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/osrc-detail.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/user"; mkdir -p "$HOME"
export OSRC_HOME="$TMP/home"
export OSRC_SOURCED=1 OSRC_RECONCILE_READ_ONLY=1
mkdir -p "$OSRC_HOME/jobs" "$OSRC_HOME/loops"
. "$SRC" >/dev/null 2>&1

for f in _job_json cmd_logs cmd_loop _loop_status_json _job_progress_lines _job_observed_model; do
  type -t "$f" >/dev/null || { echo "FAIL: $f not loaded"; exit 1; }
done

pass=0; fail=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }
# check <label> <json> <jq-filter that must be true>
check() {
  local label="$1" out="$2" filter="$3" lines
  lines="$(printf '%s\n' "$out" | grep -c '^')"
  if [ "$lines" != "1" ]; then bad "$label: expected one line of output, got $lines"; return; fi
  if printf '%s' "$out" | jq -e "(.schema_version == \"1\") and ($filter)" >/dev/null 2>&1; then ok "$label"
  else bad "$label: $filter  <-  $out"; fi
}

# --- a claude-format job: JSON event stream, markers inside strings, a secret in one of them ---------
jd="$OSRC_JOBS/j-cc"; mkdir -p "$jd"
printf 'running\n' > "$jd/status"
printf '{"id":"j-cc","provider":"claude","verb":"edit","model":"opus","tier":"frontier","cwd":"/r/site","started":1700000000,"watchdog":{"warn_s":300,"stall_s":900,"hard_s":3600},"worktree":"/r/site/.wt/a","branch":"osrc/a","base_sha":"abc123"}\n' > "$jd/meta.json"
cat > "$jd/out.log" <<'EOF'
{"type":"system","subtype":"init","model":"claude-sonnet-4-6","tools":["Read"]}
{"type":"user","message":"Protocol: print OSRC::PROGRESS <step> <5-10 words on what you are doing now>"}
{"type":"assistant","message":{"content":[{"type":"text","text":"OSRC::PROGRESS 1/3 reading checkout.spec.ts\nmore"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"OSRC::PROGRESS#a1b2c3 2/3 export API_KEY=supersecretvalue123"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"OSRC::PROGRESS 3/3 running playwright with Bearer abcdefghijklmnop"}]}}
EOF

out="$(_job_json j-cc | jq -c .)"
check "status --json: progress.line is the latest marker text"  "$out" '.progress.line | startswith("3/3 running playwright")'
check "status --json: progress.line is redacted"                "$out" '(.progress.line | contains("abcdefghijklmnop") | not) and (.progress.line | contains("[REDACTED-BEARER]"))'
check "status --json: history is oldest first, template dropped" "$out" '(.progress.history | length) == 3 and (.progress.history[0] | startswith("1/3"))'
check "status --json: history is redacted"                      "$out" '(.progress.history | map(contains("supersecretvalue123")) | any) | not'
check "status --json: observed model comes from the init event" "$out" '.observed_model == "claude-sonnet-4-6" and .model == "opus"'
check "status --json: watchdog windows from meta"               "$out" '.watchdog.hard_s == 3600 and .watchdog.stall_s == 900'
check "status --json: worktree from meta"                       "$out" '.worktree == {path:"/r/site/.wt/a", branch:"osrc/a", base_sha:"abc123"}'
check "status --json: no check recorded -> verify null"         "$out" '.verify == null'
check "status --json: existing fields unchanged"                "$out" '.progress.last_marker == "OSRC::PROGRESS" and .progress.reads == 1 and .verb == "edit"'

# --- a plain-text lane job from before this change: no watchdog in meta, worktree.json on disk -------
jd="$OSRC_JOBS/j-old"; mkdir -p "$jd"
printf 'done\n' > "$jd/status"; printf '0\n' > "$jd/exit"
printf '{"id":"j-old","provider":"codex","verb":"run","model":"gpt-5.6-sol","started":1700000000}\n' > "$jd/meta.json"
printf '{"path":"/r/ora/.wt/b","branch":"osrc/b","base_sha":"def456","head_sha":"999"}\n' > "$jd/worktree.json"
printf 'working\nOSRC::DONE\n' > "$jd/out.log"
out="$(_job_json j-old | jq -c .)"
check "old job: unknowns are null, not guessed" "$out" '.watchdog == null and .observed_model == null and .progress.line == null and .progress.history == []'
check "old job: worktree falls back to worktree.json" "$out" '.worktree.path == "/r/ora/.wt/b" and .worktree.branch == "osrc/b"'

# --- a job with no meta.json still carries every key ---------------------------------------------------
mkdir -p "$OSRC_JOBS/j-bare"; printf 'launching\n' > "$OSRC_JOBS/j-bare/status"
out="$(_job_json j-bare | jq -c .)"
check "no meta.json: new keys present as null" "$out" 'has("observed_model") and has("watchdog") and has("worktree") and has("verify") and .progress.line == null'

# --- logs --masked / --tail ------------------------------------------------------------------------------
raw="$(cmd_logs j-cc --tail 3 2>/dev/null)"
masked="$(cmd_logs j-cc --tail 3 --masked 2>/dev/null)"
[ "$(printf '%s\n' "$raw" | grep -c '^')" = 3 ] && ok "logs --tail 3 prints 3 lines" || bad "logs --tail 3 printed: $raw"
printf '%s' "$raw" | grep -q 'abcdefghijklmnop' && ok "logs without --masked stays raw" || bad "logs raw lost content"
if printf '%s' "$masked" | grep -q 'abcdefghijklmnop\|supersecretvalue123'; then bad "logs --masked leaked a secret: $masked"
else ok "logs --masked redacts secrets"; fi
[ "$(cmd_logs j-cc -n 2 2>/dev/null | grep -c '^')" = 2 ] && ok "logs -n still works" || bad "logs -n broke"
( cmd_logs j-cc --bogus >/dev/null 2>&1 ) && bad "logs must refuse unknown flags" || ok "logs refuses unknown flags"

# --- loop status --json ------------------------------------------------------------------------------------
ld="$OSRC_HOME/loops/l-flaky"; mkdir -p "$ld"
printf 'task: fix flaky checkout tests\ncheck: npx playwright test checkout --retries=0\nmodel: gpt-5.6-sol\nmax: 4\nmax-minutes: 20\nverb: edit\nworktree: 1\nstarted: %s\n' "$(( $(date +%s) - 600 ))" > "$ld/meta"
printf 'running\n' > "$ld/state"; printf '3\n' > "$ld/attempt"
printf '3 failed\nError: coupon total mismatch\n' > "$ld/check-1.out"
printf '1 failed: coupon after cart hydrate TOKEN=abcd1234efgh\n' > "$ld/check-2.out"
printf '1 failed: coupon after cart hydrate\n' > "$ld/last_fail"
ld2="$OSRC_HOME/loops/l-done"; mkdir -p "$ld2"
printf 'task: t\ncheck: true\nmodel: <default>\nmax: 3\nmax-minutes: 0\nverb: edit\nworktree: 0\nstarted: 1700000000\n' > "$ld2/meta"
printf 'success\n' > "$ld2/state"; printf '2\n' > "$ld2/attempt"
printf 'FAIL x\n' > "$ld2/check-1.out"; printf 'all good\n' > "$ld2/check-2.out"

out="$(cmd_loop status --json)"
check "loop status --json lists every loop" "$out" '(.loops | length) == 2'
check "loop status --json: attempts + stop rules" "$out" '(.loops[] | select(.loop_id=="l-flaky")) as $l
  | $l.attempt == 3 and ($l.attempts | length) == 2 and $l.attempts[0].first_failure == "3 failed"
  and $l.stop_rules == {max_attempts:4, max_minutes:20, same_failure_guard:true} and $l.worktree == true
  and ($l.elapsed_s >= 600) and $l.state == "running"'
check "loop status --json: failures are redacted" "$out" '[.loops[].attempts[].first_failure // ""] | map(contains("abcd1234efgh")) | any | not'
check "loop status --json: only the final attempt of a success passed" "$out" '(.loops[] | select(.loop_id=="l-done")) as $l
  | ($l.attempts | map(.passed)) == [false, true] and $l.model == null'
out="$(cmd_loop status l-done --json)"
check "loop status <id> --json filters to one loop" "$out" '(.loops | length) == 1 and .loops[0].loop_id == "l-done"'
( cmd_loop status nope --json >/dev/null 2>&1 ) && bad "unknown loop id must fail" || ok "unknown loop id fails"
( cmd_loop status '../x' --json >/dev/null 2>&1 ) && bad "path-like loop id must fail" || ok "path-like loop id refused"
cmd_loop status 2>/dev/null | grep "^LOOP" >/dev/null && ok "loop status text output unchanged" || bad "loop status text header missing"

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
