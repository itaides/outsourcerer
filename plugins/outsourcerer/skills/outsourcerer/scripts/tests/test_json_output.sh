#!/usr/bin/env bash
# test_json_output.sh — `--json` on the read-only commands (brief, tab, estimate, explain, and the
# status form of mode, consent, exclude, limits, heartbeat).
#
# Each payload must be ONE line of valid JSON with schema_version "1", carry the same facts as the
# text output, use null for unknowns, and leave the plain-text output unchanged. Lane probes and live
# limit readers are stubbed, so this runs offline and never touches the real ~/.outsourcerer.
#
# Run: bash test_json_output.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../outsourcerer.sh"
[ -f "$SRC" ] || { echo "FAIL: cannot find $SRC"; exit 1; }
bash -n "$SRC" || { echo "FAIL: bash -n failed for $SRC"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required for this test"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/osrc-json.XXXXXX")"; trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/user"; mkdir -p "$HOME"
export OSRC_HOME="$TMP/home"
export OSRC_SOURCED=1
unset OSRC_EXCLUDE_MODELS OSRC_CC_PRESSURE 2>/dev/null || true
mkdir -p "$OSRC_HOME/jobs"
. "$SRC" >/dev/null 2>&1

for f in cmd_brief cmd_tab cmd_estimate cmd_explain cmd_mode cmd_consent cmd_exclude cmd_limits cmd_heartbeat _json_flag_split _tab_jq_defs; do
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

# Offline stubs for everything that probes a lane or reads a live meter.
_ready_lanes()             { echo "local=ollama codex=sol/terra devin=glm/swe"; }
_session_limits()          { echo "claude5h=62 claude7d=41 codex5h=28 codexwk=73 codexage=10800"; }
_plan_lanes_meter()        { echo "devin plan: 3 of 20 runs today"; }
_parity_repair_deadlinks() { echo "repaired 1 link (this must not reach stdout)"; return 0; }
_codex_quota_line()        { return 1; }
_heartbeat_leader_alive()  { return 1; }

# --- mode ---
check "mode status --json, unset"   "$(cmd_mode status --json)" '.mode == null and .invalid_file == false'
cmd_mode auto >/dev/null
check "mode --json after auto"      "$(cmd_mode --json)"        '.mode == "auto" and (.meaning | test("auto-pilot"))'
printf 'bogus\n' > "$OSRC_MODE_FILE"
check "mode --json, invalid file"   "$(cmd_mode status --json 2>/dev/null)" '.mode == null and .invalid_file == true'
cmd_mode auto >/dev/null
( cmd_mode auto --json >/dev/null 2>&1 ) && bad "mode auto --json must be refused" || ok "mode --json only applies to status"
case "$(cmd_mode status)" in "driving mode: auto"*) ok "mode status text unchanged" ;; *) bad "mode status text changed" ;; esac

# --- consent ---
check "consent --json, not granted" "$(cmd_consent --json)" '.granted == false and .granted_at == null'
cmd_consent grant >/dev/null
check "consent status --json"       "$(cmd_consent status --json)" '.granted == true and (.granted_at | type) == "string"'

# --- exclude ---
check "exclude ls --json, empty"    "$(cmd_exclude ls --json)" '.entries == [] and .invalid == []'
printf 'fable\n# a comment\nGemini-Flash-Lite\n' > "$OSRC_EXCLUDE_FILE"
out="$(OSRC_EXCLUDE_MODELS=gpt-5.5 cmd_exclude --json)"
check "exclude --json, saved + env" "$out" '(.entries | map(.entry)) == ["fable","gemini-flash-lite","gpt-5.5"] and (.entries[2].source == "env") and (.entries[0].source == "saved")'
printf 'fable\nbad name!\n' > "$OSRC_EXCLUDE_FILE"
check "exclude --json, invalid entry" "$(cmd_exclude ls --json)" '(.invalid | length) == 1 and (.entries | map(.entry)) == ["fable"]'
rm -f "$OSRC_EXCLUDE_FILE"

# --- limits ---
check "limits status --json, none"  "$(cmd_limits status --json)" '.caps == []'
cmd_limits set any glm-5.2 50/day >/dev/null
check "limits --json, one cap"      "$(cmd_limits --json)" '(.caps | length) == 1 and .caps[0].per_day == 50 and .caps[0].lane == null and .caps[0].used_today == null and .caps[0].reset == "utc"'
case "$(cmd_limits status)" in *"glm-5.2"*"/50"*) ok "limits status text unchanged" ;; *) bad "limits status text changed" ;; esac

# --- heartbeat ---
out="$(cmd_heartbeat status --json)"; rc=$?
check "heartbeat status --json, not armed" "$out" '.armed == false and .pid == null'
[ "$rc" = "1" ] && ok "heartbeat --json keeps rc 1 when not armed" || bad "heartbeat --json rc was $rc"
_heartbeat_leader_alive() { return 0; }
mkdir -p "$OSRC_HEARTBEAT/leader"; printf '{"pid":4242}\n' > "$OSRC_HEARTBEAT/leader/owner.json"
check "heartbeat --json, armed"     "$(cmd_heartbeat --json)" '.armed == true and .pid == 4242'

# --- estimate ---
out="$(cmd_estimate --json "map the auth module and list every token refresh path")"
check "estimate --json, no pricing cache" "$out" '.pricing_cached == false and .cash_chain == [] and (.plan_lanes | length) == 6 and (.counterfactual_opus_usd > 0) and .prompt_tokens > 0'
mkdir -p "$(dirname "$OSRC_MODELS_JSON")"
first="$(printf '%s' "${OR_OFFLOAD_CHAIN:-$OR_CHAIN_DEFAULT}" | tr ',' ' ' | awk '{print $1}')"
jq -cn --arg id "$first" '{data:[{id:$id, pricing:{prompt:"0.000001", completion:"0.000002"}}]}' > "$OSRC_MODELS_JSON"
out="$(cmd_estimate "map the auth module" --json)"
check "estimate --json, priced chain" "$out" '.pricing_cached == true and (.cash_chain[0].usd | type) == "number" and ([.cash_chain[1:][] | .usd] | all(. == null))'

# --- tab ---
check "tab --json, empty ledger"    "$(cmd_tab --json)" '.runs == 0 and .plans == [] and .by_model == [] and .codex_quota == null'
cat > "$OSRC_LEDGER" <<'L'
{"lane":"cx","provider":"codex-native","model":"gpt-5.6-sol","verb":"edit","cost_usd":""}
{"lane":"cx","provider":"codex-native","model":"gpt-5.6-sol","verb":"run","cost_usd":""}
{"lane":"or","provider":"openrouter","model":"z-ai/glm-5.2","verb":"run","cost_usd":"0.12"}
{"lane":"or","provider":"openrouter","model":"z-ai/glm-5.2","verb":"run","cost_usd":"~0.05"}
{"lane":"local","provider":"local","model":"glm-5.2:q4","verb":"run","cost_usd":""}
this line is not json
L
out="$(cmd_tab --json 2>/dev/null)"
check "tab --json, totals"          "$out" '.runs == 5 and .cash_measured_usd == 0.12 and .cash_estimated_usd == 0.05 and .plan_runs == 2 and .local_runs == 1 and .skipped_lines == 1'
check "tab --json, plans + models"  "$out" '.plans == [{"plan":"ChatGPT","runs":2}] and (.by_model | map(.runs) | add) == 5'
txt="$(cmd_tab 2>/dev/null)"
case "$txt" in *"runs recorded          : 5"*"subscription / included : 2 run(s)"*"ChatGPT: 2 run(s)"*) ok "tab text unchanged after sharing the jq defs" ;; *) bad "tab text changed: $txt" ;; esac

# --- explain ---
jd="$OSRC_JOBS/j-perm"; mkdir -p "$jd"
printf 'permission-blocked\n' > "$jd/status"; printf 'permission-blocked:denials=2\n' > "$jd/reason"; printf '3\n' > "$jd/exit"
printf '{"id":"j-perm","model":"glm-5-2","verb":"edit","provider":"devin","started":1700000000}\n' > "$jd/meta.json"
printf '%s\n' "Permission denied: rejected api_key=sk-live-SECRETKEY1234567890 in sandbox" "Permission denied by sandbox" > "$jd/out.log"
out="$(cmd_explain --json j-perm)"
check "explain --json, permission-blocked" "$out" '.job == "j-perm" and .state == "permission-blocked" and .exit == 3 and .verb == "edit" and .reason == "permission-blocked:denials=2" and (.evidence | length) >= 1 and (.verdict.label | test("^(REUSE-OUTPUT|RETRY-DIFFERENT-LANE|REAL-FAIL)$"))'
case "$out" in *SECRETKEY*) bad "explain --json leaked a secret from out.log" ;; *) ok "explain --json evidence is redacted" ;; esac
mkdir -p "$OSRC_JOBS/j-bare"; printf 'failed\n' > "$OSRC_JOBS/j-bare/status"; : > "$OSRC_JOBS/j-bare/out.log"
check "explain id --json, sparse job" "$(cmd_explain j-bare --json)" '.state == "failed" and .exit == null and .reason == null and .evidence == []'

# --- brief ---
out="$(OSRC_CONSERVE_THRESHOLD=50 cmd_brief --json 2>/dev/null)"
check "brief --json, limits"        "$out" '.limits.claude_5h_pct == 62 and .limits.claude_7d_pct == 41 and .limits.codex_weekly_pct == 73 and .limits.codex_reading_age_s == 10800'
check "brief --json, conserve"      "$out" '.conserve.binding_pct == 62 and .conserve.threshold_pct == 50 and .conserve.active == true and (.conserve.recommendation | type) == "string"'
check "brief --json, lanes + mode"  "$out" '.lanes_installed == ["local=ollama","codex=sol/terra","devin=glm/swe"] and .mode == "auto" and (.notices | length) >= 1'
_session_limits() { echo ""; }
check "brief --json, unknown limits" "$(cmd_brief --json 2>/dev/null)" '.limits.claude_5h_pct == null and .limits_raw == null and .conserve.binding_pct == null and .conserve.active == null'

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
