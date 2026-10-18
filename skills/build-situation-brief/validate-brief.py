#!/usr/bin/env python3
"""Validate + sanitise brief.json in place. Usage: validate-brief.py <brief.json>  → prints "valid dropped=N" or "invalid: …".
Rules: timeline entries without a retrieved source are DROPPED; claims without sources become "unverified"; travel
without sources becomes "unknown"; enums enforced; "safe"/"no danger" assertions rejected; ≥ 1 sourced timeline entry
required for a live (non-fixture) brief. Only "gemini-grounded" and "fixture" providers are accepted; fixture briefs
must be fully synthetic (every timeline entry synthetic, no sources anywhere) so a simulation can never pass as cited."""
import json, re, sys

VERDICTS = {"supported", "contradicted", "outdated", "unverified"}
FEAS = {"ok", "caution", "avoid", "unknown"}
FORBIDDEN = [r"\b(is|are|it's|it is) (completely |totally |now )?safe\b", r"\bno (danger|risk) (at all|whatsoever)\b", r"\bsafe to (travel|go|cross|drive)\b"]

def sourced(xs): return [s for s in (xs or []) if isinstance(s, dict) and str(s.get("url", "")).startswith("https://")]

def main():
    p = sys.argv[1]; b = json.load(open(p)); errs = []
    prov = b.get("provider")
    if prov not in ("gemini-grounded", "fixture"): errs.append(f"unknown provider {prov!r}")
    live = prov == "gemini-grounded"
    if prov == "fixture":
        for x in b.get("timeline") or []:
            if not x.get("synthetic"): errs.append("fixture timeline entry not marked synthetic")
            if x.get("sources"): errs.append("fixture timeline entry carries sources")
        if any(c.get("sources") for c in b.get("claimChecks") or []) or (b.get("travelAssessment") or {}).get("sources"):
            errs.append("fixture brief carries sources")
    tl = []; dropped = 0
    for x in b.get("timeline") or []:
        x["sources"] = sourced(x.get("sources"))
        if live and not x["sources"]: dropped += 1; continue
        if x.get("confidence") not in ("high", "medium", "low"): x["confidence"] = "low"
        tl.append(x)
    b["timeline"] = tl
    for c in b.get("claimChecks") or []:
        c["sources"] = sourced(c.get("sources"))
        if c.get("verdict") not in VERDICTS: errs.append(f"bad verdict {c.get('verdict')!r}")
        if live and not c["sources"] and c.get("verdict") != "unverified":
            c["verdict"] = "unverified"; c["evidence"] = ("No retrievable source was cited. " + str(c.get("evidence", "")))[:300]
    t = b.get("travelAssessment")
    if t:
        t["sources"] = sourced(t.get("sources"))
        if t.get("feasibility") not in FEAS: errs.append("bad travel feasibility")
        if live and not t["sources"] and t.get("feasibility") != "unknown":
            t["feasibility"] = "unknown"; t["reasons"] = ["No retrievable source supported a feasibility judgement."] + (t.get("reasons") or [])[:3]
    if live and not tl: errs.append("no sourced timeline entries — nothing reliable to show")
    text = " ".join([str(b.get("headline", "")), str(b.get("summary", ""))] + [x.get("summary", "") for x in tl]
                    + [c.get("evidence", "") for c in b.get("claimChecks") or []] + (t.get("reasons", []) if t else []))
    for pat in FORBIDDEN:
        if re.search(pat, text, re.I): errs.append(f"forbidden assertion /{pat}/")
    b["droppedUnsourced"] = dropped
    json.dump(b, open(p, "w"))
    if errs: print("invalid:\n- " + "\n- ".join(errs)); return 1
    print(f"valid dropped={dropped}"); return 0

if __name__ == "__main__":
    sys.exit(main())
