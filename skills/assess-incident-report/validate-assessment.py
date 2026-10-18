#!/usr/bin/env python3
"""Validate the agent's assessment.json against schema.json + IncidentLens safety rules.

Usage: validate-assessment.py <assessment.json> <vision.json>   → exit 0 and prints "valid", or exit 1 with reasons.
Rules beyond the schema: evidenceUsed must cite only labels/objects present in vision.json; non-ok Vision forces
manual_review with a vision_<status> reason; fixture Vision requires the vision_fixture reason; forbidden claims
(authenticity, exact severity, real/fake, blame, safety, dispatch) are rejected.
"""
import json, os, re, sys

FORBIDDEN = [
    r"\bproven?\b", r"\bgenuine\b", r"\bauthentic", r"\bfake\b", r"\bfabricated\b", r"\breal or fake\b", r"\bdoctored\b",
    r"\bcaused (the|this)\b", r"\bat fault\b", r"\bto blame\b", r"\bsafe to (cross|drive|enter|pass)\b",
    r"\b(ambulance|police|fire (brigade|service)|team)s? (has|have|was|were) (been )?(dispatched|sent|notified)\b",
    r"\bseverity is (exactly|precisely)\b", r"\bexact(ly)? \d+ (people|injur|casualt)", r"\bdepth (is|of) \d",
]

def main():
    a, v = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
    schema = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.json")))
    errs = []
    for k in schema["required"]:
        if k not in a: errs.append(f"missing {k}")
    props = schema["properties"]
    def enum_ok(key):
        if key in a and "enum" in props[key] and a[key] not in props[key]["enum"]: errs.append(f"{key} not allowed: {a.get(key)!r}")
    for k in ("assessmentState", "suggestedCategory", "uncertainty"): enum_ok(k)
    for k in ("observations", "uncertaintyNote"):
        if not isinstance(a.get(k, ""), str) or len(a.get(k, "")) > props[k]["maxLength"]: errs.append(f"{k} must be a string ≤ {props[k]['maxLength']}")
    if not isinstance(a.get("urgencyHint"), bool): errs.append("urgencyHint must be boolean")
    for k in ("qualityFlags", "reviewReasons"):
        if not isinstance(a.get(k), list): errs.append(f"{k} must be a list")
    allowed_flags = props["qualityFlags"]["items"]["enum"]
    for f in a.get("qualityFlags") or []:
        if f not in allowed_flags: errs.append(f"unknown quality flag {f!r}")
    # Optional AI triage (advisory): which services, which priority — validated when present.
    svc = a.get("suggestedServices")
    if svc is not None:
        allowed_svc = props["suggestedServices"]["items"]["properties"]["service"]["enum"]
        if not isinstance(svc, list) or len(svc) > 3: errs.append("suggestedServices must be a list of ≤ 3")
        else:
            for x in svc:
                if not isinstance(x, dict) or x.get("service") not in allowed_svc: errs.append(f"unknown suggested service {x!r}")
                elif not isinstance(x.get("reason", ""), str) or len(x.get("reason", "")) > 140: errs.append("suggestedServices.reason must be ≤ 140 chars")
            if len({x.get("service") for x in svc if isinstance(x, dict)}) != len(svc): errs.append("suggestedServices has duplicates")
    if "suggestedPriority" in a and a["suggestedPriority"] not in props["suggestedPriority"]["enum"]: errs.append("suggestedPriority must be P1–P4")
    if len(str(a.get("priorityReason", ""))) > 200: errs.append("priorityReason too long")
    ev = a.get("evidenceUsed") or {}
    have = {x.get("description", "").lower() for x in v.get("labels") or []} | {x.get("name", "").lower() for x in v.get("objects") or []}
    for key in ("visionLabels", "visionObjects"):
        for item in ev.get(key) or []:
            if str(item).lower() not in have: errs.append(f"evidenceUsed.{key} cites {item!r}, which Vision did not return")
    if len(str(ev.get("visualObservation", ""))) > 300: errs.append("evidenceUsed.visualObservation too long")
    status = v.get("status")
    reasons = a.get("reviewReasons") or []
    if status not in ("ok", "fixture"):
        if a.get("assessmentState") != "manual_review": errs.append(f"Vision status {status!r} requires assessmentState manual_review")
        if f"vision_{status}" not in reasons: errs.append(f"reviewReasons must include vision_{status}")
    if status == "fixture" and "vision_fixture" not in reasons: errs.append("reviewReasons must include vision_fixture (annotations are local fixtures)")
    text = " ".join(str(a.get(k, "")) for k in ("observations", "uncertaintyNote")) + " " + str(ev.get("visualObservation", ""))
    text += " " + str(a.get("priorityReason", "")) + " " + " ".join(str(x.get("reason", "")) for x in (svc or []) if isinstance(x, dict))
    for pat in FORBIDDEN:
        if re.search(pat, text, re.I): errs.append(f"forbidden claim matched /{pat}/")
    if errs:
        print("invalid:\n- " + "\n- ".join(errs)); return 1
    print("valid"); return 0

if __name__ == "__main__":
    sys.exit(main())
