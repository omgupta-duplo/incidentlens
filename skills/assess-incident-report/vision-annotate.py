#!/usr/bin/env python3
"""IncidentLens Cloud Vision tool — model-independent, runs under any agent that can execute python3.

Usage: vision-annotate.py --spec shared/incidentlens-report.json --photo <jpeg> --out <vision.json>
Writes ONLY the normalized annotation JSON to --out and prints the out path + a status word. Never prints
credentials, request bodies or OCR text to stdout/stderr.

Modes (from the expanded spec's incidentLens.visionMode):
  live     — call Google Cloud Vision v1 images:annotate with the server-side scope credential
             (other_scopes/vision-api.json: Credential.Data.apiKey, or serviceAccountJson via google-auth)
  fixture  — LOCAL DEVELOPMENT ONLY: canned annotations, provider "fixture" (never real provenance)
  none     — no Vision configured → status "skipped_no_scope"

Bounded: fixed feature set (labels ≤10, objects ≤10, text ≤300 chars), image ≤4 MB, one overall 60 s deadline,
per-attempt timeout min(20 s, remaining), ≤2 retries on 429/5xx/timeout only and only when time remains.
Billing: Vision bills per image PER FEATURE (3 units here). Dedup is best-effort: the server's stored result
(--existing, fetched just in time) → API; a per-photo lock prevents concurrent duplicate calls in this run; a
timed-out attempt is recorded as possibly billed. No annotation cache is written to the ticket workdir (ticket
files are readable by every workspace member), so OCR text never persists there.
"""
import argparse, base64, glob, json, os, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone

FEATURES = [{"type": "LABEL_DETECTION", "maxResults": 10},
            {"type": "OBJECT_LOCALIZATION", "maxResults": 10},
            {"type": "TEXT_DETECTION"},
            {"type": "WEB_DETECTION", "maxResults": 10}]   # "seen online before?" — recycled rumour photos
FEATURE_SET = "v2"
DEADLINE_S, PER_ATTEMPT_S, MAX_RETRIES, BACKOFF = 60.0, 20.0, 2, (2.0, 6.0)
MAX_IMAGE = 4 * 1024 * 1024
ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"

FIXTURES = {
    "road_collision": (["Car", "Vehicle", "Road", "Traffic", "Motor vehicle", "Asphalt"], ["Car", "Car", "Person"], ""),
    "pothole_road_damage": (["Road", "Asphalt", "Road surface", "Pothole", "Tar"], [], ""),
    "waterlogging_flood": (["Water", "Flood", "Road", "Puddle", "Street"], ["Car"], ""),
    "fallen_tree_obstruction": (["Tree", "Branch", "Road", "Plant", "Trunk"], ["Tree"], ""),
    "smoke_fire_indicator": (["Smoke", "Sky", "Building", "Haze"], ["Building"], ""),
}

def now():
    return datetime.now(timezone.utc).isoformat()

def emit(out, block, word):
    tmp = out + ".tmp"
    with open(tmp, "w") as f:
        json.dump(block, f)
    os.replace(tmp, out)
    print(f"{out} {word}")

def base(status, provider=None, from_cache=False, attempts=None, error=None):
    return {"status": status, "provider": provider, "apiVersion": "v1" if provider == "google-cloud-vision" else None,
            "features": [f["type"] for f in FEATURES] if provider else [], "annotatedAt": now(),
            "fromCache": from_cache, "attempts": attempts or [], "labels": [], "objects": [],
            "text": {"snippet": "", "truncated": False, "untrusted": True},
            "web": {"fullMatches": 0, "partialMatches": 0, "pages": [], "bestGuess": None}, "error": error}

def normalize_web(r):
    """Web Detection → counts + up to 5 pages that already show this exact/partial image (URLs are public pages)."""
    w = r.get("webDetection") or {}
    pages = []
    for pg in (w.get("pagesWithMatchingImages") or [])[:5]:
        url = str(pg.get("url", ""))[:300]
        if url.startswith(("http://", "https://")):
            pages.append({"url": url, "title": " ".join(str(pg.get("pageTitle", "")).replace("<b>", "").replace("</b>", "").split())[:120]})
    guess = ((w.get("bestGuessLabels") or [{}])[0].get("label") or None)
    return {"fullMatches": len(w.get("fullMatchingImages") or []), "partialMatches": len(w.get("partialMatchingImages") or []),
            "pages": pages, "pagesWithMatches": len(w.get("pagesWithMatchingImages") or []),
            "bestGuess": (str(guess)[:80] if guess else None)}

def normalize(resp):
    r = (resp.get("responses") or [{}])[0]
    if "error" in r:
        raise ValueError("vision returned an error object")
    labels = [{"description": str(x.get("description", ""))[:60], "score": round(float(x.get("score", 0)), 2)}
              for x in (r.get("labelAnnotations") or [])[:10]]
    objects = []
    for o in (r.get("localizedObjectAnnotations") or [])[:10]:
        v = (o.get("boundingPoly") or {}).get("normalizedVertices") or []
        xs = [float(p.get("x", 0)) for p in v] or [0]; ys = [float(p.get("y", 0)) for p in v] or [0]
        objects.append({"name": str(o.get("name", ""))[:60], "score": round(float(o.get("score", 0)), 2),
                        "box": [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)]})
    full = ((r.get("fullTextAnnotation") or {}).get("text")
            or ((r.get("textAnnotations") or [{}])[0].get("description") if r.get("textAnnotations") else "") or "")
    full = " ".join(full.split())
    return labels, objects, {"snippet": full[:300], "truncated": len(full) > 300, "untrusted": True}, normalize_web(r)

def scope_credential(spec):
    want = (spec.get("scopeIds") or (spec.get("spec") or {}).get("scopeIds") or [])
    # Multiple scopes are now attached. Never choose Maps (or an ungranted Vision scope).
    matches = {}
    for p in glob.glob("other_scopes/*.json"):
        try:
            with open(p) as source:
                s = json.load(source)
        except Exception:
            continue
        if s.get("Id") in want and s.get("Name") == "vision-api":
            matches[s["Id"]] = s
    if len(matches) != 1:
        return None
    chosen = next(iter(matches.values()))
    data = (chosen.get("Credential") or {}).get("Data") or {}
    return {k.lower(): v for k, v in data.items()}

def auth_headers(cred):
    if cred.get("apikey"):
        return {"x-goog-api-key": cred["apikey"]}
    if cred.get("serviceaccountjson"):
        # Supported Google library — no hand-rolled JWT signing.
        from google.oauth2 import service_account
        import google.auth.transport.requests
        info = json.loads(cred["serviceaccountjson"])
        c = service_account.Credentials.from_service_account_info(info, scopes=["https://www.googleapis.com/auth/cloud-vision"])
        c.refresh(google.auth.transport.requests.Request())
        return {"Authorization": f"Bearer {c.token}"}
    raise KeyError("credential has neither apiKey nor serviceAccountJson")

def call_vision(photo_b64, headers):
    body = json.dumps({"requests": [{"image": {"content": photo_b64}, "features": FEATURES}]}).encode()
    start, attempts = time.monotonic(), []
    for i in range(MAX_RETRIES + 1):
        remaining = DEADLINE_S - (time.monotonic() - start)
        if remaining < 3:
            break
        req = urllib.request.Request(ENDPOINT, data=body, method="POST",
                                     headers={"Content-Type": "application/json", **headers})
        try:
            with urllib.request.urlopen(req, timeout=min(PER_ATTEMPT_S, remaining)) as r:
                attempts.append({"at": now(), "outcome": "ok", "possiblyBilled": True})
                return json.load(r), attempts
        except urllib.error.HTTPError as e:
            kind = "http_429" if e.code == 429 else "http_5xx" if e.code >= 500 else "http_4xx"
            attempts.append({"at": now(), "outcome": kind, "possiblyBilled": e.code >= 500})
            if kind == "http_4xx":
                raise RuntimeError(f"vision http {e.code}") from None
        except (TimeoutError, OSError) as e:
            to = "timed out" in str(e).lower() or isinstance(e, TimeoutError)
            attempts.append({"at": now(), "outcome": "timeout" if to else "network", "possiblyBilled": to})
        if i < MAX_RETRIES:
            wait = BACKOFF[i]
            if DEADLINE_S - (time.monotonic() - start) <= wait + 5:
                break
            time.sleep(wait)
    raise TimeoutError("vision deadline/retries exhausted")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spec", required=True); ap.add_argument("--photo", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--workdir", required=True); ap.add_argument("--existing")
    a = ap.parse_args()
    spec = json.load(open(a.spec))
    il = spec.get("incidentLens") or {}
    mode, sha = il.get("visionMode", "none"), il.get("photoSha256") or "unknown"

    existing = json.load(open(a.existing)) if a.existing and os.path.exists(a.existing) else None
    if existing and existing.get("status") == "ok":
        existing["fromCache"] = True
        return emit(a.out, existing, "ok-reused-server-result")

    if mode == "none":
        return emit(a.out, base("skipped_no_scope"), "skipped_no_scope")
    if mode == "fixture":
        cat = (spec.get("spec") or {}).get("categoryHint") or "road_collision"
        labels, objects, text = FIXTURES.get(cat, FIXTURES["road_collision"])
        b = base("fixture", provider="fixture")
        b["labels"] = [{"description": l, "score": round(0.95 - i * 0.05, 2)} for i, l in enumerate(labels)]
        b["objects"] = [{"name": o, "score": 0.8, "box": [0.1, 0.2, 0.6, 0.8]} for o in objects]
        b["text"] = {"snippet": text, "truncated": False, "untrusted": True}
        return emit(a.out, b, "fixture")

    lock = os.path.join(a.workdir, f"{sha}.{FEATURE_SET}.lock")
    cache = os.path.join(a.workdir, f"{sha}.{FEATURE_SET}.json")   # in-run only; the workdir is removed at the end
    # Per-photo lock: a concurrent run in this ticket waits for the first call instead of paying twice.
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY); os.close(fd)
    except FileExistsError:
        for _ in range(65):
            if os.path.exists(cache):
                b = json.load(open(cache)); b["fromCache"] = True
                return emit(a.out, b, "ok-cached")
            if time.time() - os.path.getmtime(lock) > 90:
                break
            time.sleep(1)
    try:
        photo = open(a.photo, "rb").read()
        if len(photo) > MAX_IMAGE:
            return emit(a.out, base("invalid", error="image_too_large"), "invalid")
        cred = scope_credential(spec)
        if not cred:
            return emit(a.out, base("skipped_no_scope", error="scope_file_missing"), "skipped_no_scope")
        try:
            headers = auth_headers(cred)
        except Exception as e:
            return emit(a.out, base("failed", provider="google-cloud-vision", error=f"auth:{type(e).__name__}"), "failed")
        try:
            resp, attempts = call_vision(base64.b64encode(photo).decode(), headers)
        except Exception as e:
            b = base("failed", provider="google-cloud-vision", error=type(e).__name__)
            return emit(a.out, b, "failed")
        try:
            labels, objects, text, web = normalize(resp)
        except Exception:
            return emit(a.out, base("invalid", provider="google-cloud-vision", attempts=attempts, error="unparseable_response"), "invalid")
        b = base("ok", provider="google-cloud-vision", attempts=attempts)
        b["labels"], b["objects"], b["text"], b["web"] = labels, objects, text, web
        with open(cache + ".tmp", "w") as f:
            json.dump(b, f)
        os.replace(cache + ".tmp", cache)          # persist before returning (dedup for re-runs)
        return emit(a.out, b, "ok")
    finally:
        try:
            os.remove(lock)
        except OSError:
            pass

if __name__ == "__main__":
    sys.exit(main())
