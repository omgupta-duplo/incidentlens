#!/usr/bin/env bash
# IncidentLens Situation Brief driver (platform-native agent research). Subcommands:
#   prepare             status Processing → per-run source ledger (fetch-source.py --init) + question.json → prints
#                       what the agent reads/writes. ALREADY_BUILT if this brief was already finalized.
#                       Opt-in fixture (INCIDENTLENS_BRIEF_FIXTURES=1, offline tests/demo) → simulated brief, SIMULATED_DONE.
#   (agent)             discovers pages, fetches each with fetch-source.py (receipts), writes $W/brief-draft.json
#   finalize            finalize-brief.py binds the draft to the ledger → POST results → status Complete only after the
#                       results were saved. No fetched sources → "unavailable"; no verifiable evidence → Failed.
#   unavailable "<why>" the search/fetch tool is unavailable → briefState "unavailable", status Failed (never fixture success)
#   fail "<reason>"     record a failed brief + status Failed
#   run                 LEGACY direct path (intel-search.py: Gemini API + Google Search grounding via the gemini-api scope);
#                       no scope → "not_configured". Not used by the native flow.
#   deprovision         nothing external → DeProvisioning → DeProvisioned
# Never prints keys. Web content is untrusted evidence.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SPEC="shared/incidentlens-brief.json"
[ -f "$SPEC" ] || { echo "spec $SPEC missing" >&2; exit 2; }
WS=$(jq -r '.ownerWorkspaceId // .OwnerWorkspaceId' "$SPEC"); ID=$(jq -r '.id // .Id' "$SPEC")
case "$ID" in ""|null|*[!A-Za-z0-9_-]*) echo "bad brief id" >&2; exit 2 ;; esac
W="${TMPDIR:-$PWD/tmp}/incidentlens-brief-$ID"; mkdir -p "$W"
L="$W/ledger"
STAMP="canvas-documents/.il-brief-finalized"
BASE="${DUPLO_BASE:-$DUPLO_HOST}"
RES="$BASE/v1/aiservicedesk/user/data/workspaces/$WS/environment/extensions/incidentlens-briefs/$ID"
H=(-H "Authorization: Bearer $DUPLO_TOKEN" -H "Content-Type: application/json")
status() { jq -nc --arg s "$1" --arg ss "${2:-}" --arg f "${3:-}" \
  '{status:$s, subStatus:$ss} + (if $f=="" then {} else {faults:[$f]} end)' \
  | curl -fsS -o /dev/null -X POST "$RES/status" "${H[@]}" --data-binary @-; }
results() { curl -fsS -o /dev/null -X POST "$RES/results" "${H[@]}" --data-binary @"$1"; }
failres() { jq -nc --arg e "$1" '{briefState:"failed", error:$e}' > "$W/result.json"; results "$W/result.json" || true; }
# A brief that already reached a finished result is never mutated again (resume, repeat, late "unavailable"/"fail"):
#  1. local stamp written after a confirmed Complete;
#  2. the state the platform recorded when this ticket's spec was generated (incidentLens.priorBriefState / priorStatus);
#  3. best effort, read-only: the brief's own route with this ticket's token (if the route allows GET; never required).
finished_state() { case "$1" in ready|simulated) return 0 ;; esac; return 1; }
done_already() {
  [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$ID" ] && return 0
  local pb ps; pb=$(jq -r '.incidentLens.priorBriefState // ""' "$SPEC"); ps=$(jq -r '.incidentLens.priorStatus // ""' "$SPEC")
  finished_state "$pb" && return 0
  [ "$ps" = Complete ] && [ -n "$pb" ] && return 0
  local cur; cur=$(curl -fsS -m 10 -H "Authorization: Bearer $DUPLO_TOKEN" "$RES" 2>/dev/null || true)
  [ -n "$cur" ] && finished_state "$(echo "$cur" | jq -r '(.data // .) | (.result.briefState // .result.BriefState // "")' 2>/dev/null || true)" && return 0
  return 1
}
guard() { if done_already; then echo "ALREADY_BUILT (finished brief; '$1' not applied)"; exit 0; fi; }
simulate() {   # 0.3.11 opt-in simulated brief (unchanged semantics)
  python3 -I "$HERE/intel-search.py" --spec "$SPEC" --out "$W/brief.json" --fixture >/dev/null
  python3 -I "$HERE/validate-brief.py" "$W/brief.json" >/dev/null
  jq '{briefState:"simulated", headline, summary, timeline, affectedAreas, claimChecks, travelAssessment, searchQueries, asOf, limits, provider, model, droppedUnsourced}' \
    "$W/brief.json" > "$W/result.json"
  results "$W/result.json"
  N=$(jq '.timeline | length' "$W/brief.json"); rm -rf "$W"
  status Complete "Simulated demo brief (fixture data, opt-in; $N synthetic entries, no sources)"
}

case "${1:-}" in
prepare)
  guard prepare
  if [ "${INCIDENTLENS_BRIEF_FIXTURES:-}" = 1 ]; then simulate; echo "SIMULATED_DONE"; exit 0; fi
  status Processing "Researching public sources (agent research: web search + fetched pages)…"
  rm -rf "$L"; python3 -I "$HERE/fetch-source.py" --ledger "$L" --init --resource "$ID" --workspace "$WS" >/dev/null
  jq '{query: .spec.query, place: .spec.place, claims: (.spec.claims // []), travel: .spec.travel}' "$SPEC" > "$W/question.json"
  cat <<TXT
READY
question: $W/question.json
rules:    $HERE/prompt-brief-v1.md
fetch:    python3 -I $HERE/fetch-source.py --ledger $L --url <https-url> --purpose "<why>"
ledger:   $L/ledger.jsonl   (read receipts + $L/sources/S<n>.txt; never edit)
write:    $W/brief-draft.json
then:     bash $HERE/brief.sh finalize
no search/fetch tool: bash $HERE/brief.sh unavailable "<which tool and why>"
TXT
  ;;
finalize)
  guard finalize
  if [ -f "$W/.results-saved" ] && [ -f "$W/result.json" ]; then     # resume: results were saved, Complete was not
    if status Complete "$(cat "$W/.complete-msg")"; then mkdir -p "$(dirname "$STAMP")"; echo "$ID" > "$STAMP"; rm -rf "$W"; echo "OK: completed (resumed)"
    else echo "FAILED: Complete status still not saved — run finalize again (results already saved)"; fi
    exit 0
  fi
  set +e; OUT=$(python3 -I "$HERE/finalize-brief.py" --ledger "$L" --draft "$W/brief-draft.json" --spec "$SPEC" --out "$W/result.json" 2>&1); RC=$?; set -e
  if [ "$RC" = 4 ]; then
    MSG="Unavailable: no public source could be fetched — no brief was produced. ($(echo "$OUT" | tail -1 | cut -c1-160))"
    jq -nc --arg e "$MSG" '{briefState:"unavailable", provider:"agent-research", error:$e, timeline:[], claimChecks:[], affectedAreas:[]}' > "$W/result.json"
    results "$W/result.json" || true; status Failed "Unavailable: no fetched sources" "unavailable"; rm -rf "$W"
    echo "UNAVAILABLE: $OUT"; exit 0
  fi
  if [ "$RC" != 0 ]; then
    failres "$(echo "$OUT" | tail -1 | cut -c1-200)"; status Failed "Brief failed verification" "$(echo "$OUT" | tail -1 | cut -c1-200)"
    rm -rf "$W"; echo "INVALID: $OUT"; exit 0
  fi
  if ! results "$W/result.json"; then
    status Failed "Result could not be saved" "results callback failed" || true
    echo "FAILED: result save failed — not marked complete (draft and ledger kept in $W)"; exit 0
  fi
  N=$(jq '.timeline | length' "$W/result.json"); R=$(jq '.rejectedCitations' "$W/result.json")
  echo "Brief ready ($N cited events from fetched pages, agent research; $R citation(s) rejected)" > "$W/.complete-msg"; touch "$W/.results-saved"
  if ! status Complete "$(cat "$W/.complete-msg")"; then
    echo "FAILED: results saved but Complete status not saved — run finalize again to complete (work kept in $W)"; exit 0
  fi
  mkdir -p "$(dirname "$STAMP")"; echo "$ID" > "$STAMP"; rm -rf "$W"
  echo "OK: $OUT"
  ;;
unavailable)
  guard unavailable
  MSG="Unavailable: ${2:-search/fetch tool not available} — no brief was produced."
  jq -nc --arg e "$MSG" '{briefState:"unavailable", provider:"agent-research", error:$e, timeline:[], claimChecks:[], affectedAreas:[]}' > "$W/result.json"
  results "$W/result.json" || true; status Failed "Unavailable: ${2:-tool not available}" "unavailable"; rm -rf "$W"; echo "UNAVAILABLE recorded" ;;
run)
  guard run
  status Processing "Searching public sources (Google Search via Gemini)…"
  if [ "${INCIDENTLENS_BRIEF_FIXTURES:-}" = 1 ]; then simulate; echo "OK: simulated (opt-in)"; exit 0; fi
  set +e; OUT=$(python3 -I "$HERE/intel-search.py" --spec "$SPEC" --out "$W/brief.json" 2>&1); RC=$?; set -e
  if [ "$RC" = 4 ]; then
    MSG="Not configured: live search (Gemini + Google Search grounding) is not set up for this workspace — no brief was produced."
    jq -nc --arg e "$MSG" '{briefState:"not_configured", error:$e, timeline:[], claimChecks:[], affectedAreas:[]}' > "$W/result.json"
    results "$W/result.json" || true; status Failed "Not configured: live search unavailable" "not_configured"
    rm -rf "$W"; echo "NOT CONFIGURED: live search unavailable; no brief produced"; exit 0
  fi
  if [ "$RC" != 0 ]; then
    failres "$(echo "$OUT" | tail -1 | cut -c1-200)"; status Failed "Search failed" "$(echo "$OUT" | tail -1 | cut -c1-200)"
    rm -rf "$W"; echo "FAILED: $OUT"; exit 0
  fi
  if ! VOUT=$(python3 -I "$HERE/validate-brief.py" "$W/brief.json"); then
    failres "$(echo "$VOUT" | tr '\n' ' ' | cut -c1-240)"; status Failed "Brief failed validation" "$(echo "$VOUT" | tr '\n' ' ' | cut -c1-240)"
    rm -rf "$W"; echo "INVALID: $VOUT"; exit 0
  fi
  jq '{briefState:"ready", headline, summary, timeline, affectedAreas, claimChecks, travelAssessment, searchQueries, asOf, limits, provider, model, droppedUnsourced}' \
    "$W/brief.json" > "$W/result.json"
  results "$W/result.json"
  N=$(jq '.timeline | length' "$W/brief.json"); rm -rf "$W"
  status Complete "Brief ready ($N cited timeline entries, gemini-grounded)"
  echo "OK: $OUT · $VOUT"
  ;;
fail) guard fail; failres "${2:-unknown}"; status Failed "${2:-unknown}"; rm -rf "$W"; echo "failed recorded" ;;
deprovision) rm -rf "$W"; status DeProvisioning "Nothing external to remove"; status DeProvisioned "Brief ticket closed; brief retained"; echo "deprovisioned" ;;
*) echo "usage: brief.sh prepare|finalize|unavailable <why>|fail <reason>|run|deprovision" >&2; exit 2 ;;
esac
