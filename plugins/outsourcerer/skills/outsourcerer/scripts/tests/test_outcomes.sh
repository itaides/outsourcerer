#!/usr/bin/env bash
# test_outcomes.sh — `outcomes [--days N] [--json]`: the Outcomes screen's data, aggregated from the
# outcome rows (outcomes-YYYYMM.jsonl). Verified means `passed` only; completed_unverified counts as
# done, never verified. Fixture rows only, offline, never touches the real ~/.outsourcerer.
#
# Run: bash test_outcomes.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../outsourcerer.sh"
[ -f "$SRC" ] || { echo "FAIL: cannot find $SRC"; exit 1; }
bash -n "$SRC" || { echo "FAIL: bash -n failed for $SRC"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required for this test"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/osrc-outcomes.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/user"; mkdir -p "$HOME"
export OSRC_HOME="$TMP/home"
export OSRC_SOURCED=1
mkdir -p "$OSRC_HOME"
. "$SRC" >/dev/null 2>&1

type -t cmd_outcomes >/dev/null || { echo "FAIL: cmd_outcomes not loaded"; exit 1; }

pass=0; fail=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; fail=$((fail+1)); }
check() {
  local label="$1" out="$2" filter="$3" lines
  lines="$(printf '%s\n' "$out" | grep -c '^')"
  if [ "$lines" != "1" ]; then bad "$label: expected one line of output, got $lines"; return; fi
  if printf '%s' "$out" | jq -e "(.schema_version == \"1\") and ($filter)" >/dev/null 2>&1; then ok "$label"
  else bad "$label: $filter  <-  $out"; fi
}

# --- no outcome files at all ---------------------------------------------------------------------------
out="$(cmd_outcomes --json)"
check "no rows: zero totals, null rate, empty matrix" "$out" '.totals.n == 0 and .verified_rate_pct == null and .matrix == [] and .trend == [] and .days == 90'

# --- fixture rows ----------------------------------------------------------------------------------------
iso() { jq -rn --argjson t "$1" '$t | todate'; }
now=$(date +%s); d=86400
row() { # <age-days> <lane> <model> <class> <outcome> [reason]
  jq -cn --arg ts "$(iso $(( now - $1 * d )))" --arg l "$2" --arg m "$3" --arg c "$4" --arg o "$5" --arg r "${6:-}" \
    '{schema:2,event:"outcome",run_id:"r",ts:$ts,lane:$l,model:$m,task_class:$c,repo_key:"1",outcome:$o} + (if $r=="" then {} else {reason:$r} end)'
}
f="$OSRC_HOME/outcomes-202610.jsonl"
{
  row 1  dv swe-2-high code completed_unverified
  row 2  dv swe-2-high code completed_unverified
  row 3  dv swe-2-high code blocked permission_denied
  row 4  dv swe-2-high code blocked permission_denied
  row 5  dv swe-2-high code abandoned timeout
  row 6  cx gpt-5.6-sol code passed
  row 6  cx gpt-5.6-sol code failed test_failure
  row 7  cx gpt-5.6-sol reasoning completed_unverified
  row 40 gm gemini-3.1-pro agentic blocked lane_down
  row 200 cx gpt-5.6-sol code passed
  echo 'not json at all'
  echo '{"event":"outcome","ts":"yesterday","lane":"dv","outcome":"passed"}'
  echo '{"event":"cost","ts":"2026-10-01T00:00:00Z"}'
} > "$f"
# a legacy flat file is read too
row 2 local glm-5.2 simple completed_unverified > "$OSRC_HOME/outcomes.jsonl"

out="$(cmd_outcomes --json)"
check "90 days: old, malformed and non-outcome rows skipped" "$out" '.totals.n == 10'
check "breakdown counts" "$out" '.totals | (.passed == 1 and .completed_unverified == 4 and .blocked == 3 and .abandoned == 1 and .failed == 1)'
check "verified rate is passed / n" "$out" '.verified_rate_pct == 10'
check "checked_runs counts graded rows only" "$out" '.checked_runs == 2'
check "matrix cell: done counts unverified, verified does not" "$out" '(.matrix[] | select(.lane=="dv" and .model=="swe-2-high" and .task_class=="code")) as $c
  | $c.n == 5 and $c.done_pct == 40 and $c.verified_pct == 0 and $c.blocked_pct == 60'
check "matrix cell: blocked reasons ranked" "$out" '(.matrix[] | select(.lane=="dv")) .blocked_reasons == [{reason:"permission_denied",n:2},{reason:"timeout",n:1}]'
check "matrix cell: a graded pass is verified" "$out" '(.matrix[] | select(.lane=="cx" and .task_class=="code")) | .verified_pct == 50 and .done_pct == 50'
check "legacy outcomes.jsonl is read" "$out" 'any(.matrix[]; .lane == "local")'
check "trend: weeks in order, counts add up" "$out" '(.trend | map(.n) | add) == 10 and (.trend | map(.week_start) | . == sort)'
check "trend weeks start on a Monday" "$out" 'all(.trend[]; (.week_start | fromdateiso8601 | strftime("%u")) == "1")'

out="$(cmd_outcomes --days 7 --json)"
check "--days narrows the window" "$out" '.days == 7 and .totals.n == 9'
out="$(cmd_outcomes --days 365 --json)"
check "--days 365 includes the old pass" "$out" '.totals.n == 11 and .totals.passed == 2'

( cmd_outcomes --days x >/dev/null 2>&1 ) && bad "--days x must be refused" || ok "--days must be a number"
( cmd_outcomes --days 0 >/dev/null 2>&1 ) && bad "--days 0 must be refused" || ok "--days 0 refused"
( cmd_outcomes --bogus >/dev/null 2>&1 ) && bad "unknown flags must be refused" || ok "unknown flags refused"

txt="$(cmd_outcomes)"
printf '%s\n' "$txt" | grep '^Outcomes, last 90 days: 10 runs · verified 10%' >/dev/null && ok "text summary line" || bad "text summary: $txt"
printf '%s\n' "$txt" | grep 'No run had a check' >/dev/null && bad "nudge must not show when a run was checked" || ok "no nudge when something was checked"

# --- nothing checked -> the nudge ---------------------------------------------------------------------------
rm -f "$OSRC_HOME"/outcomes*.jsonl
row 1 dv swe-2-high code completed_unverified > "$OSRC_HOME/outcomes-202610.jsonl"
out="$(cmd_outcomes --json)"
check "nothing checked: 0% verified, 0 checked" "$out" '.verified_rate_pct == 0 and .checked_runs == 0'
cmd_outcomes | grep 'No run had a check' >/dev/null && ok "text nudges when nothing was checked" || bad "missing nudge"

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
