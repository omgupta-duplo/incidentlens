#!/usr/bin/env python3
"""IncidentLens source fetcher — the ONLY way evidence enters a Situation Brief's source ledger.

The agent decides WHAT to read; this helper does the reading and writes a receipt itself, so every citation in a brief
can be checked against content a program actually retrieved (not model knowledge, not a search snippet).

Usage: fetch-source.py --ledger <dir> --url <https-url> [--purpose <text>]
       fetch-source.py --ledger <dir> --init --resource <briefId> --workspace <wsId>   (brief.sh prepare only:
         creates the per-run key, run.json {resourceId, workspaceId, runId, createdAt, fetcher, mac}, empty ledger)
  stdout: "S<n> <httpStatus> <finalUrl> chars=<n>"   exit 0  (receipt + sources/S<n>.txt written)
          "REJECTED <reason>"                          exit 2  (URL not allowed; attempt logged, nothing citable)
          "FETCH_FAILED <reason>"                      exit 3  (network/HTTP/content failure; attempt logged)
URL rules: https only, port 443, no userinfo, <= 2048 chars, no secret-looking query parameters; the host must resolve
only to public addresses and the connection is pinned to the validated address (SNI/Host = the name); <= 5 redirects,
each hop re-validated; no cookies or auth headers; body <= 2 MB; 15 s timeout; text content types only.
Receipts are MACed with the per-run key in <ledger>/.key (detects hand-written/edited receipts — not a boundary
against a deliberately malicious process with the same file access). Page text is untrusted evidence.
"""
import argparse, hashlib, hmac, html, ipaddress, json, os, re, socket, ssl, sys, unicodedata, urllib.parse
import http.client
from datetime import datetime, timezone

FETCHER = "incidentlens-fetch-source/1"
MAX_URL, MAX_BODY, MAX_TEXT, MAX_REDIRECTS, TIMEOUT = 2048, 2 * 1024 * 1024, 200_000, 5, 15
TEXT_TYPES = ("text/html", "text/plain", "application/xhtml+xml", "application/xml", "text/xml", "application/rss+xml", "application/atom+xml", "application/json")
SECRET_PARAM = re.compile(r"(^|[_\-.])(key|apikey|api_key|token|access_token|id_token|sig|signature|secret|password|passwd|pwd|auth|authorization|credential|credentials|session|sessionid|jwt|code)$|^x-amz-|^x-goog-", re.I)
UA = "IncidentLens-SituationBrief/1 (+evidence fetcher; no cookies)"

class Rejected(Exception): pass
class Failed(Exception): pass

def now(): return datetime.now(timezone.utc).isoformat(timespec="seconds")

def canonical(d): return json.dumps(d, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()

def mac(key, d): return hmac.new(key, canonical({k: v for k, v in d.items() if k != "mac"}), hashlib.sha256).hexdigest()

def read_key(ledger):
    try: k = open(os.path.join(ledger, ".key"), "rb").read().strip()
    except OSError: raise Rejected("ledger not prepared (no key)")
    if len(k) < 32: raise Rejected("ledger key invalid")
    return k

def public_ip(ip):
    a = ipaddress.ip_address(ip)
    if a.version == 6 and a.ipv4_mapped: a = a.ipv4_mapped
    return a.is_global and not (a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or a.is_reserved or a.is_unspecified)

def check_url(url):
    """Return (host, path_with_query, pinned_ip) or raise Rejected."""
    if not isinstance(url, str) or len(url) > MAX_URL: raise Rejected("url too long or not a string")
    if any(c in url for c in "\r\n\t ") : raise Rejected("whitespace/control characters in url")
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https": raise Rejected("only https URLs are allowed")
    if u.username is not None or u.password is not None or "@" in u.netloc: raise Rejected("userinfo in url")
    try: port = u.port
    except ValueError: raise Rejected("bad port")
    if port not in (None, 443): raise Rejected("only port 443")
    host = (u.hostname or "").rstrip(".").lower()
    if not host or "." not in host: raise Rejected("host must be a public DNS name")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet")):
        raise Rejected("non-public host name")
    for k, _ in urllib.parse.parse_qsl(u.query, keep_blank_values=True):
        if SECRET_PARAM.search(k): raise Rejected(f"secret-looking query parameter '{k[:40]}'")
    if u.fragment and SECRET_PARAM.search(u.fragment.split("=")[0]): raise Rejected("secret-looking fragment")
    try:
        ipaddress.ip_address(host.strip("[]")); literal = True
    except ValueError: literal = False
    if literal: raise Rejected("IP-literal hosts are not allowed")
    try: addrs = sorted({ai[4][0] for ai in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)})
    except socket.gaierror: raise Failed("dns resolution failed")
    if not addrs: raise Failed("dns resolution returned nothing")
    bad = [a for a in addrs if not public_ip(a)]
    if bad: raise Rejected("host resolves to a non-public address")
    path = (u.path or "/") + (("?" + u.query) if u.query else "")
    return host, path, addrs[0]

class PinnedHTTPS(http.client.HTTPSConnection):
    """HTTPS to a pre-validated IP; certificate and SNI checked against the host name (no DNS re-resolution)."""
    def __init__(self, host, ip, **kw):
        super().__init__(host, 443, timeout=TIMEOUT, context=ssl.create_default_context(), **kw); self._ip = ip
    def connect(self):
        sock = socket.create_connection((self._ip, 443), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)

def get(url):
    hops = []; cur = url
    for _ in range(MAX_REDIRECTS + 1):
        host, path, ip = check_url(cur)
        c = PinnedHTTPS(host, ip)
        try:
            c.request("GET", path, headers={"User-Agent": UA, "Accept": "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.1", "Accept-Encoding": "identity", "Connection": "close"})
            r = c.getresponse()
            if r.status in (301, 302, 303, 307, 308):
                loc = r.getheader("Location") or ""; r.read(0); c.close()
                if not loc: raise Failed(f"redirect {r.status} without Location")
                nxt = urllib.parse.urljoin(cur, loc); hops.append({"url": cur, "status": r.status}); cur = nxt; continue
            ctype = (r.getheader("Content-Type") or "").split(";")[0].strip().lower()
            body = r.read(MAX_BODY + 1)
            return cur, hops, r.status, ctype, (r.getheader("Content-Type") or ""), body
        except (OSError, http.client.HTTPException, ssl.SSLError) as e:
            raise Failed(f"{type(e).__name__}")
        finally: c.close()
    raise Failed("too many redirects")

def decode(body, ctype_full):
    m = re.search(r"charset=([\w.-]+)", ctype_full, re.I); enc = m.group(1) if m else None
    if not enc:
        m = re.search(rb"<meta[^>]+charset=[\"']?([\w.-]+)", body[:4096], re.I); enc = m.group(1).decode("ascii", "ignore") if m else "utf-8"
    try: return body.decode(enc, errors="replace")
    except LookupError: return body.decode("utf-8", errors="replace")

def meta(doc, *names):
    for n in names:
        m = re.search(r"<meta[^>]+(?:property|name|itemprop)=[\"']" + re.escape(n) + r"[\"'][^>]*content=[\"']([^\"']{1,200})", doc, re.I) \
            or re.search(r"<meta[^>]+content=[\"']([^\"']{1,200})[\"'][^>]*(?:property|name|itemprop)=[\"']" + re.escape(n) + r"[\"']", doc, re.I)
        if m: return html.unescape(m.group(1)).strip()
    return None

def normalize(t):
    t = unicodedata.normalize("NFKC", t)
    t = t.translate({0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"', 0x2013: "-", 0x2014: "-", 0xA0: " "})
    return re.sub(r"\s+", " ", t).strip()

def to_text(doc, ctype):
    if ctype in ("text/html", "application/xhtml+xml"):
        doc = re.sub(r"(?is)<(script|style|noscript|template|svg|head)\b.*?</\1>", " ", doc)
        doc = re.sub(r"(?s)<!--.*?-->", " ", doc)
        doc = re.sub(r"(?i)<(br|/p|/div|/li|/h[1-6]|/tr|/section|/article)\b[^>]*>", "\n", doc)
        doc = re.sub(r"(?s)<[^>]+>", " ", doc)
        doc = html.unescape(doc)
    return normalize(doc)[:MAX_TEXT]

def append(path, rec):
    with open(path, "a", encoding="utf-8") as f: f.write(json.dumps(rec, ensure_ascii=False) + "\n")

def next_id(ledger):
    n = 0
    try:
        for line in open(os.path.join(ledger, "ledger.jsonl"), encoding="utf-8"):
            m = re.match(r"S(\d+)$", (json.loads(line).get("id") or ""))
            if m: n = max(n, int(m.group(1)))
    except (OSError, ValueError): pass
    return f"S{n + 1}"

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--ledger", required=True); ap.add_argument("--url"); ap.add_argument("--purpose", default="")
    ap.add_argument("--init", action="store_true"); ap.add_argument("--resource"); ap.add_argument("--workspace")
    a = ap.parse_args(); ledger = a.ledger
    if a.init:
        import secrets, uuid
        if not (a.resource and a.workspace): print("REJECTED --init needs --resource and --workspace"); return 2
        os.makedirs(os.path.join(ledger, "sources"), exist_ok=True)
        kp = os.path.join(ledger, ".key")
        fd = os.open(kp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f: f.write(secrets.token_hex(32))
        key = read_key(ledger)
        run = {"resourceId": a.resource, "workspaceId": a.workspace, "runId": uuid.uuid4().hex, "createdAt": now(), "fetcher": FETCHER}
        run["mac"] = mac(key, run)
        json.dump(run, open(os.path.join(ledger, "run.json"), "w"))
        for f in ("ledger.jsonl", "attempts.jsonl"): open(os.path.join(ledger, f), "w").close()
        print(f"INIT {run['runId']}"); return 0
    if not a.url: print("REJECTED --url is required"); return 2
    attempt = {"requestedUrl": a.url[:MAX_URL], "at": now(), "purpose": a.purpose[:200]}
    try:
        key = read_key(ledger)
        run = json.load(open(os.path.join(ledger, "run.json")))
        final, hops, status, ctype, ctype_full, body = get(a.url)
        if len(body) > MAX_BODY: raise Failed("body larger than 2 MB")
        if not 200 <= status < 300: raise Failed(f"http {status}")
        if ctype not in TEXT_TYPES: raise Failed(f"unsupported content type {ctype or 'none'}")
        doc = decode(body, ctype_full); text = to_text(doc, ctype)
        if len(text) < 40: raise Failed("no readable text")
        sid = next_id(ledger); os.makedirs(os.path.join(ledger, "sources"), exist_ok=True)
        tpath = os.path.join(ledger, "sources", sid + ".txt")
        with open(tpath, "w", encoding="utf-8") as f: f.write(text)
        title = None
        if ctype in ("text/html", "application/xhtml+xml"):
            m = re.search(r"(?is)<title[^>]*>(.*?)</title>", doc); title = normalize(html.unescape(m.group(1)))[:200] if m else None
        rec = {"id": sid, "runId": run.get("runId"), "requestedUrl": a.url, "finalUrl": final, "redirects": hops, "httpStatus": status,
               "contentType": ctype, "fetchedAt": now(), "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest(),
               "textSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(), "textChars": len(text), "title": title,
               # fetcher-observed page metadata (publication time is NOT retrieval time; either may be absent)
               "publishedAt": meta(doc, "article:published_time", "datePublished", "pubdate", "date", "dc.date") if ctype == "text/html" else None,
               "modifiedAt": meta(doc, "article:modified_time", "dateModified", "last-modified") if ctype == "text/html" else None,
               "purpose": a.purpose[:200], "fetcher": FETCHER}
        rec["mac"] = mac(key, rec)
        append(os.path.join(ledger, "ledger.jsonl"), rec)
        append(os.path.join(ledger, "attempts.jsonl"), {**attempt, "outcome": "ok", "id": sid})
        print(f"{sid} {status} {final} chars={len(text)}"); return 0
    except Rejected as e:
        try: append(os.path.join(ledger, "attempts.jsonl"), {**attempt, "outcome": "rejected", "reason": str(e)})
        except OSError: pass
        print(f"REJECTED {e}"); return 2
    except (Failed, OSError, ValueError) as e:
        try: append(os.path.join(ledger, "attempts.jsonl"), {**attempt, "outcome": "failed", "reason": str(e)[:160]})
        except OSError: pass
        print(f"FETCH_FAILED {str(e)[:160]}"); return 3

if __name__ == "__main__":
    sys.exit(main())
