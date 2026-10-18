#!/usr/bin/env python3
"""Finalize a native (agent-research) Situation Brief: bind the agent's draft to the fetcher's source ledger.

Usage: finalize-brief.py --ledger <dir> --draft <brief-draft.json> --spec <shared/incidentlens-brief.json> --out <result.json>
stdout: "ready cited=<n> dropped=<n> rejected=<n>" exit 0 · "unavailable: <why>" exit 4 · "failed: <why>" exit 1

Fetcher-observed facts (URL, final URL, HTTP status, retrieval time, hashes, page title, page publication metadata) come
ONLY from MAC-verified ledger receipts. Model assertions (headline, summary, event times, verdicts, wording) come from the
draft and are labelled as agent assertions. A citation is valid only if its sourceId is a unique, MAC-verified,
2xx receipt of THIS run whose stored text still matches its hash, and its quote appears verbatim in that text.
The draft can never supply URLs, provider, run/resource ids or callbacks. Retrieval time is never used as event time.
"""
import argparse, hashlib, hmac, json, os, re, sys, unicodedata, urllib.parse
from collections import Counter
from datetime import datetime, timezone, timedelta

VERDICTS = {"supported", "contradicted", "outdated", "unverified"}
FEAS = {"ok", "caution", "avoid", "unknown"}
CONF = {"high", "medium", "low"}
FORBIDDEN = [r"\b(is|are|it's|it is) (completely |totally |now )?safe\b", r"\bno (danger|risk) (at all|whatsoever)\b", r"\bsafe to (travel|go|cross|drive)\b"]
DRAFT_KEYS = {"headline", "summary", "limits", "timeline", "claims", "affectedAreas", "travel", "searchQueries"}
QMIN, QMAX = 12, 400

def canonical(d): return json.dumps(d, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
def mac(key, d): return hmac.new(key, canonical({k: v for k, v in d.items() if k != "mac"}), hashlib.sha256).hexdigest()
def normalize(t):
    t = unicodedata.normalize("NFKC", str(t))
    t = t.translate({0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"', 0x2013: "-", 0x2014: "-", 0xA0: " "})
    return re.sub(r"\s+", " ", t).strip()
def domain(u):
    try: return (urllib.parse.urlsplit(u).hostname or "").lower().removeprefix("www.")
    except ValueError: return ""
def s(x, n): return str(x if x is not None else "")[:n]
def parse_time(v):
    try: return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except (TypeError, ValueError): return None

FETCHER = "incidentlens-fetch-source/1"
TEXT_TYPES = {"text/html", "text/plain", "application/xhtml+xml", "application/xml", "text/xml", "application/rss+xml", "application/atom+xml", "application/json"}
HEX64 = re.compile(r"[0-9a-f]{64}")

def receipt_shape(r):
    """Only receipts written by fetch-source.py for a full page fetch are evidence (not search snippets or other types)."""
    if r.get("fetcher") != FETCHER: return f"fetcher {str(r.get('fetcher'))[:40]!r}"
    if not str(r.get("requestedUrl", "")).startswith("https://"): return "requestedUrl"
    if r.get("contentType") not in TEXT_TYPES: return "contentType"
    for k in ("sha256", "textSha256"):
        if not isinstance(r.get(k), str) or not HEX64.fullmatch(r[k]): return k
    if not (isinstance(r.get("bytes"), int) and r["bytes"] > 0 and isinstance(r.get("textChars"), int) and r["textChars"] >= 40): return "size"
    if not isinstance(r.get("redirects"), list) or len(r["redirects"]) > 5: return "redirects"
    t = parse_time(r.get("fetchedAt"))
    if not (t and t.tzinfo): return "fetchedAt"
    if t > datetime.now(timezone.utc) + timedelta(minutes=5): return "fetchedAt in the future"
    extra = set(r) - {"id", "runId", "requestedUrl", "finalUrl", "redirects", "httpStatus", "contentType", "fetchedAt", "bytes", "sha256",
                      "textSha256", "textChars", "title", "publishedAt", "modifiedAt", "purpose", "fetcher", "mac"}
    if extra: return "unexpected fields " + ",".join(sorted(extra)[:3])
    return ""

class Fail(Exception): pass
class Unavailable(Exception): pass

def load_ledger(ledger, spec):
    try: key = open(os.path.join(ledger, ".key"), "rb").read().strip()
    except OSError: raise Unavailable("no source ledger (prepare did not run)")
    try: run = json.load(open(os.path.join(ledger, "run.json")))
    except (OSError, ValueError): raise Fail("ledger run header missing or unreadable")
    if run.get("mac") != mac(key, run): raise Fail("ledger run header MAC mismatch")
    rid = spec.get("id") or spec.get("Id"); ws = spec.get("ownerWorkspaceId") or spec.get("OwnerWorkspaceId")
    if run.get("resourceId") != rid or run.get("workspaceId") != ws: raise Fail("ledger belongs to a different brief/workspace")
    recs, notes = [], []
    try: lines = open(os.path.join(ledger, "ledger.jsonl"), encoding="utf-8").read().splitlines()
    except OSError: lines = []
    for i, line in enumerate(lines):
        try: r = json.loads(line)
        except ValueError: notes.append(f"ledger line {i + 1} unreadable"); continue
        recs.append(r)
    ids = Counter(r.get("id") for r in recs)
    good = {}
    if not parse_time(run.get("createdAt")): notes.append("run header has no start time — fetch times not checked against the run")
    for r in recs:
        sid = r.get("id")
        if ids[sid] > 1: notes.append(f"{sid}: duplicate id — ignored"); continue
        if not isinstance(sid, str) or not re.fullmatch(r"S\d{1,4}", sid): notes.append("bad source id — ignored"); continue
        if r.get("mac") != mac(key, r): notes.append(f"{sid}: receipt MAC mismatch — ignored"); continue
        shape = receipt_shape(r)
        if shape: notes.append(f"{sid}: not a fetcher receipt ({shape}) — ignored"); continue
        if r.get("runId") != run.get("runId"): notes.append(f"{sid}: receipt from another run — ignored"); continue
        started = parse_time(run.get("createdAt"))
        if started and parse_time(r.get("fetchedAt")) < started:
            notes.append(f"{sid}: fetched before this run started — ignored"); continue
        if not (isinstance(r.get("httpStatus"), int) and 200 <= r["httpStatus"] < 300): notes.append(f"{sid}: not a successful retrieval — ignored"); continue
        if not str(r.get("finalUrl", "")).startswith("https://"): notes.append(f"{sid}: non-https final URL — ignored"); continue
        try: text = open(os.path.join(ledger, "sources", sid + ".txt"), encoding="utf-8").read()
        except OSError: notes.append(f"{sid}: stored text missing — ignored"); continue
        if hashlib.sha256(text.encode("utf-8")).hexdigest() != r.get("textSha256"): notes.append(f"{sid}: stored text changed after retrieval — ignored"); continue
        good[sid] = (r, normalize(text))
    return run, good, notes

def main():
    ap = argparse.ArgumentParser()
    for k in ("--ledger", "--draft", "--spec", "--out"): ap.add_argument(k, required=True)
    a = ap.parse_args()
    spec = json.load(open(a.spec))
    run, good, notes = load_ledger(a.ledger, spec)
    if not good: raise Unavailable("no successfully fetched sources in the ledger" + (f" ({'; '.join(notes[:3])})" if notes else ""))
    try: d = json.load(open(a.draft, encoding="utf-8"))
    except FileNotFoundError: raise Fail("draft missing")
    except ValueError: raise Fail("draft is not valid JSON")
    if not isinstance(d, dict): raise Fail("draft must be a JSON object")
    extra = sorted(set(d) - DRAFT_KEYS)
    if extra: notes.append("ignored draft fields: " + ", ".join(extra[:6]))       # e.g. url/provider/callback — never trusted

    used = set(); rejected = 0; reasons = Counter()
    def cite(cs):
        nonlocal rejected
        out = []
        for c in cs if isinstance(cs, list) else []:
            if not isinstance(c, dict): rejected += 1; reasons["malformed citation"] += 1; continue
            sid, q = c.get("sourceId"), normalize(c.get("quote", ""))
            if sid not in good: rejected += 1; reasons["unknown/unfetched source id"] += 1; continue
            if not QMIN <= len(q) <= QMAX: rejected += 1; reasons["quote length"] += 1; continue
            r, text = good[sid]
            if q not in text: rejected += 1; reasons["quote not in fetched text"] += 1; continue
            if any(x["sourceId"] == sid and x["quote"] == q for x in out): continue
            used.add(sid)
            out.append({"sourceId": sid, "url": r["finalUrl"], "title": r.get("title") or domain(r["finalUrl"]), "domain": domain(r["finalUrl"]),
                        "quote": q, "fetchedAt": r["fetchedAt"], "publishedAt": r.get("publishedAt")})
        return out[:4]

    timeline, dropped = [], 0
    for x in (d.get("timeline") or [])[:14] if isinstance(d.get("timeline"), list) else []:
        if not isinstance(x, dict): dropped += 1; continue
        src = cite(x.get("citations"))
        if not src: dropped += 1; continue
        timeline.append({"at": s(x.get("at"), 60) or "time not stated", "summary": s(x.get("summary"), 240),
                         "confidence": x.get("confidence") if x.get("confidence") in CONF else "low", "sources": src})
    if not timeline: raise Fail("no verifiable evidence: no timeline entry cites fetched text")
    claims = []
    for c in (d.get("claims") or [])[:5] if isinstance(d.get("claims"), list) else []:
        if not isinstance(c, dict): continue
        src = cite(c.get("citations")); v = c.get("verdict") if c.get("verdict") in VERDICTS else "unverified"
        ev = s(c.get("evidence"), 300)
        if not src and v != "unverified": v, ev = "unverified", ("No fetched source supports a verdict. " + ev)[:300]
        claims.append({"claim": s(c.get("claim"), 240), "verdict": v, "evidence": ev, "asOf": s(c.get("asOf"), 60), "sources": src})
    areas = []
    for x in (d.get("affectedAreas") or [])[:8] if isinstance(d.get("affectedAreas"), list) else []:
        if not isinstance(x, dict): continue
        src = cite(x.get("citations"))
        if src: areas.append({"name": s(x.get("name"), 120), "note": s(x.get("note"), 160), "lat": None, "lng": None, "sources": src})
    travel = None
    if (spec.get("spec") or {}).get("travel"):
        tj = d.get("travel") if isinstance(d.get("travel"), dict) else {}
        src = cite(tj.get("citations")); f = tj.get("feasibility") if tj.get("feasibility") in FEAS else "unknown"
        reasons_t = [s(r, 200) for r in (tj.get("reasons") or [])[:5]] if isinstance(tj.get("reasons"), list) else []
        if not src and f != "unknown": f, reasons_t = "unknown", ["No fetched source supported a feasibility judgement."] + reasons_t[:3]
        travel = {"feasibility": f, "reasons": reasons_t, "sources": src, "routeEtaMin": None, "routeKm": None}

    text = " ".join([s(d.get("headline"), 120), s(d.get("summary"), 500)] + [x["summary"] for x in timeline]
                    + [c["evidence"] for c in claims] + (travel["reasons"] if travel else []))
    for pat in FORBIDDEN:
        if re.search(pat, text, re.I): raise Fail(f"forbidden assertion /{pat}/")

    # limitations derived from fetcher-observed facts (not model assertions)
    lim = []
    # identical page text at different addresses is one source (syndication/reposts), not independent corroboration
    by_text = {}
    for i in sorted(used): by_text.setdefault(good[i][0]["textSha256"], []).append(i)
    dupes = [ids for ids in by_text.values() if len(ids) > 1]
    for ids in dupes: lim.append(f"Duplicate text: {', '.join(ids)} carry the same page text at different addresses — not independent corroboration.")
    doms = {domain(good[ids[0]][0]["finalUrl"]) for ids in by_text.values()}
    if len(doms) < 2: lim.append("Single-source: every cited statement comes from one website (or copies of one page).")
    pubs = [parse_time(good[i][0].get("publishedAt")) for i in used]
    known = [p for p in pubs if p and p.tzinfo]
    if not known: lim.append("No cited page states a publication time; event times are the agent's reading of the text.")
    elif max(known) < datetime.now(timezone.utc) - timedelta(days=7): lim.append("Possibly stale: the newest cited page was published over 7 days ago.")
    if any(c["verdict"] == "contradicted" for c in claims): lim.append("Some claims are contradicted by fetched sources — read the evidence before relying on them.")
    if dropped: lim.append(f"{dropped} statement(s) without verifiable fetched evidence were removed.")
    if rejected: lim.append(f"{rejected} citation(s) failed verification ({', '.join(f'{k} ×{v}' for k, v in reasons.items())}).")

    ledger_pub = [{"id": i, "url": r["finalUrl"], "title": r.get("title"), "domain": domain(r["finalUrl"]), "httpStatus": r["httpStatus"],
                   "fetchedAt": r["fetchedAt"], "publishedAt": r.get("publishedAt"), "sha256": r["sha256"], "cited": i in used}
                  for i, (r, _) in sorted(good.items(), key=lambda kv: int(kv[0][1:]))]
    out = {"briefState": "ready", "provider": "agent-research", "model": (spec.get("incidentLens") or {}).get("agentModel"),
           "assertions": "agent", "runId": run["runId"], "asOf": max(r["fetchedAt"] for r, _ in good.values()),
           "headline": s(d.get("headline"), 120), "summary": s(d.get("summary"), 500), "timeline": timeline, "affectedAreas": areas,
           "claimChecks": claims, "travelAssessment": travel,
           "searchQueries": [s(q, 120) for q in (d.get("searchQueries") or [])[:8]] if isinstance(d.get("searchQueries"), list) else [],
           "limits": (s(d.get("limits"), 240) or "Public web pages fetched during this run only; not an official advisory."),
           "limitations": lim, "ledger": ledger_pub, "droppedUnsourced": dropped, "rejectedCitations": rejected, "ledgerNotes": notes[:10]}
    json.dump(out, open(a.out, "w"))
    print(f"ready cited={len(timeline)} dropped={dropped} rejected={rejected}"); return 0

if __name__ == "__main__":
    try: sys.exit(main())
    except Unavailable as e: print(f"unavailable: {e}"); sys.exit(4)
    except Fail as e: print(f"failed: {e}"); sys.exit(1)
    except Exception as e: print(f"failed: {type(e).__name__}"); sys.exit(1)
