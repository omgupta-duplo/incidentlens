// Generic list endpoints return raw entities (no read enrichment), so derive the processing state the same way
// the backend does (IncidentLensReportService.Derive).
export function processingState(r: any): string {
  const s = r?.status, a = r?.result?.assessmentState;
  if (s === 'New') return 'received';
  if (s === 'TicketCreated') return 'queued';
  if (s === 'Processing' || s === 'Updated') return !a ? 'analyzing' : a === 'ready' ? 'ready_for_review' : 'manual_review';
  if (s === 'Complete') return a === 'ready' ? 'ready_for_review' : 'manual_review';
  return 'manual_review';
}
export const isActiveAssignment = (s: string) => ['requested', 'acknowledged', 'en_route', 'on_scene'].includes(s);
export const sourceLabel = (s?: string) => s === 'manual' ? 'manual pin · lower confidence' : s === 'gps_adjusted' ? 'GPS, adjusted by reporter' : s === 'gps' ? 'GPS' : '—';

// ── readable titles / location fallback (existing data only; no geocoding) ─────────────────────────────
const CAT_SHORT: Record<string, string> = {
  road_collision: 'Road collision', pothole_road_damage: 'Road damage', waterlogging_flood: 'Waterlogging / flood',
  fallen_tree_obstruction: 'Fallen tree / obstruction', smoke_fire_indicator: 'Smoke / fire', other_uncertain: 'Reported issue',
};
const fmtWhen = (d?: string | Date | null) => {
  if (!d) return '';
  const t = new Date(d); if (isNaN(t.getTime())) return '';
  return t.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
/** "Road collision · 15 Oct, 08:38" — category (assessment, else reporter hint) + time. The id stays visible as the reference. */
export function reportTitle(r: any, category?: string | null): string {
  const c = category ?? r?.result?.assessment?.suggestedCategory ?? r?.spec?.categoryHint ?? r?.categoryHint;
  const when = fmtWhen(r?.spec?.receivedAt ?? r?.receivedAt ?? r?.createdAt);
  return [CAT_SHORT[c] ?? 'Reported issue', when].filter(Boolean).join(' · ');
}
/** "Road collision — MG Road junction" (jurisdiction), else category + time. */
export function incidentTitle(i: any): string {
  const s = i?.spec ?? i ?? {};
  const c = CAT_SHORT[s.category] ?? 'Incident';
  const where = (s.jurisdiction ?? '').trim();
  return where ? `${c} — ${where}` : [c, fmtWhen(i?.createdAt)].filter(Boolean).join(' · ');
}
/** Coordinates with source, or an honest fallback when the location is missing. */
export function locationText(lat?: number | null, lng?: number | null, source?: string, accuracyM?: number | null): string {
  if (lat == null || lng == null || isNaN(+lat) || isNaN(+lng)) return 'Location not available';
  const acc = accuracyM ? ` ±${Math.round(accuracyM)} m` : '';
  return `${(+lat).toFixed(5)}, ${(+lng).toFixed(5)} · ${sourceLabel(source)}${acc}`;
}

// ── assessment outcome: an UNCERTAIN result is a finished assessment, not a processing failure ─────────
export type ReviewKind = 'pending' | 'ready' | 'uncertain' | 'failed';
export function reviewKind(r: any): ReviewKind {
  const s = r?.status, a = r?.result?.assessment, st = r?.result?.assessmentState;
  if (s === 'Failed' || s === 'Blocked') return 'failed';
  if (['New', 'TicketCreated'].includes(s) || ((s === 'Processing' || s === 'Updated') && !st)) return 'pending';
  if (st === 'ready') return 'ready';
  // manual_review WITH a validated interpretation = the model answered but was unsure; without one = it failed.
  return a?.observations ? 'uncertain' : 'failed';
}
export const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  pending: 'Assessment running', ready: 'Ready for review', uncertain: 'Review — AI uncertain', failed: 'Review — AI unavailable',
};
export const REVIEW_KIND_TONE: Record<ReviewKind, string> = { pending: 'analyzing', ready: 'ready_for_review', uncertain: 'manual_review', failed: 'failed' };

// ── grouping: the score is a heuristic similarity, NOT a probability and NOT corroboration ───────────
export function matchStrength(score: number): string { return score >= 0.7 ? 'Strong' : score >= 0.45 ? 'Moderate' : 'Weak'; }

// ── next actions (derived from existing state only) ───────────────────────────────────────────────────
export function incidentNextAction(i: any): string {
  const rs = i?.result?.responseState;
  const pending = (i?.result?.assistanceRequests ?? []).filter((x: any) => x.state === 'pending').length;
  switch (rs) {
    case 'under_review': return 'Dispatch a team from the Teams tab.';
    // needs_reassignment / awaiting_allocation already carry their own alert with the next step.
    case 'in_response': return pending ? `Teams are working. ${pending} help request${pending === 1 ? ' is' : 's are'} awaiting allocation.` : 'Teams are working — monitor statuses and notes.';
    case 'response_complete': return 'Review the resolution evidence in Teams, then close the incident.';
    case 'closed': return 'Closed. Reopen with a reason if the problem returns.';
    default: return '';
  }
}
/** Admin-side closure outcome from assignment counts: cancelled work is never presented as resolved. */
export function closureOutcome(i: any): string {
  if (!i?.result?.closed) return '';
  const st = (i.result.assignmentSummary ?? []).map((a: any) => a.state);
  const done = st.filter((s: string) => s === 'completed').length, cancelled = st.filter((s: string) => s === 'cancelled').length;
  if (!done) return `Closed without a completed response${cancelled ? ` — ${cancelled} assignment${cancelled === 1 ? ' was' : 's were'} cancelled` : ''}. This is not a resolution.`;
  return `Closed after ${done} completed assignment${done === 1 ? '' : 's'}${cancelled ? `; ${cancelled} cancelled (not counted as resolved)` : ''}.`;
}

// ── Pulse map heat: more reports + more recent → hotter. Text label always accompanies the colour (not colour-only).
export type HeatLevel = 'calm' | 'warm' | 'hot' | 'critical';
// color = map/legend swatch; text = label colour with ≥ 4.5:1 contrast on white (axe-verified).
export const HEAT_STYLE: Record<HeatLevel, { color: string; text: string; label: string }> = {
  calm: { color: '#0b6e78', text: '#0b6e78', label: 'Calm' }, warm: { color: '#b7791f', text: '#8a5a00', label: 'Warm' },
  hot: { color: '#d9480f', text: '#a8330a', label: 'Hot' }, critical: { color: '#b3261e', text: '#a61b29', label: 'Critical' },
};
/**
 * score = 0.55 × volume (1 report → 0, 5+ reports → 1) + 0.45 × recency (last report now → 1, older than the
 * category's grouping window (min 30 min) → 0). Levels: < .25 calm, < .5 warm, < .75 hot, else critical.
 */
export function heatOf(reportCount: number, lastReportAt: string | number | Date | null | undefined, windowMinutes: number, now: number): { level: HeatLevel; score: number } {
  const volume = Math.max(0, Math.min(1, (reportCount - 1) / 4));
  const last = lastReportAt == null ? NaN : new Date(lastReportAt).getTime();
  const mins = isNaN(last) ? Infinity : Math.max(0, (now - last) / 60000);
  const recency = Math.max(0, 1 - mins / Math.max(30, windowMinutes || 0));
  const score = Math.round((0.55 * volume + 0.45 * recency) * 100) / 100;
  const level: HeatLevel = score < 0.25 ? 'calm' : score < 0.5 ? 'warm' : score < 0.75 ? 'hot' : 'critical';
  return { level, score };
}
/** Reports visible at replay time t (inclusive); returns count + latest time. */
export function replayAt(reports: { receivedAt: string }[], t: number): { count: number; last: string | null } {
  let count = 0, last: string | null = null;
  for (const r of reports) { const ts = new Date(r.receivedAt).getTime(); if (ts <= t) { count++; if (!last || ts > new Date(last).getTime()) last = r.receivedAt; } }
  return { count, last };
}

// ── D4: facility provenance wording — only server-recorded provenance may name Google; fixture data says simulated.
export function facilityProvenance(spec: any): { source: string; route: string | null; fixture: boolean } {
  const prov = spec?.facilityProvider, route = spec?.routeProvider, min = spec?.routeEtaMinutes, km = spec?.routeDistanceKm;
  const source = prov === 'google_places' ? 'Facility found via Google Maps'
    : prov === 'fixture' ? 'FIXTURE facility (simulated data)' : 'Facility (source not recorded)';
  const dist = km != null ? `, ${km} km` : '';
  const routeText = min == null ? null
    : route === 'google_routes' ? `drive time at dispatch ${min} min${dist} (Google Routes)`
    : route === 'fixture' ? `simulated drive time ${min} min${dist} (fixture data, not live traffic)`
    : `drive time ${min} min${dist} (source not recorded — not verified)`;
  return { source, route: routeText, fixture: prov === 'fixture' || route === 'fixture' };
}

// ── D6: after an in-app screen change, move focus to the new screen's heading — but only when focus was lost.
export function pathOf(url: string): string { return (url || '').split(/[?#]/)[0]; }
/** Query/fragment-only changes (tabs, filters, wizard state) never move focus; neither does focus a user already placed. */
export function shouldMoveFocus(prevUrl: string, nextUrl: string, focusLost: boolean): boolean {
  return focusLost && pathOf(prevUrl) !== pathOf(nextUrl);
}
/** Focus is "lost" when it sits on <body>, on a removed element, or on one that is no longer rendered (e.g. a closed menu). */
export function isFocusLost(active: Element | null, body: Element | null): boolean {
  if (!active || active === body) return true;
  if (!active.isConnected) return true;
  const el = active as HTMLElement;
  return typeof el.getClientRects === 'function' && el.getClientRects().length === 0;
}

// ── Situation brief display (mirrors backend BriefDisplay.Of; the server's `display` wins when present).
// Only a live, grounded result is "Ready"; fixture briefs (even ones stored as "ready") are simulated and cite nothing.
export interface BriefView { state: 'ready' | 'simulated' | 'not_configured' | 'unavailable' | 'failed' | 'unverified' | 'building'; label: string; citedEvents: number; syntheticEntries: number; }
export function briefDisplay(b: any): BriefView {
  const d = b?.display;
  if (d && typeof d.state === 'string') return { state: d.state, label: d.label, citedEvents: d.citedEvents ?? 0, syntheticEntries: d.syntheticEntries ?? 0 };
  const r = b?.result ?? {}, tl: any[] = r.timeline ?? [], status = b?.status;
  const fixture = r.provider === 'fixture', research = r.provider === 'agent-research', grounded = r.provider === 'gemini-grounded' || research;
  const synthetic = fixture ? tl.length : tl.filter(x => x?.synthetic).length;
  const cited = grounded ? tl.filter(x => !x?.synthetic && (x?.sources ?? []).some((s: any) => String(s?.url ?? '').startsWith('https://')
                                                                                  && (!research || (!!s?.sourceId && !!s?.quote)))).length : 0;
  if (r.briefState === 'not_configured') return { state: 'not_configured', label: 'Not configured', citedEvents: 0, syntheticEntries: 0 };
  if (r.briefState === 'unavailable') return { state: 'unavailable', label: 'Unavailable', citedEvents: 0, syntheticEntries: 0 };
  if (r.briefState === 'failed' || status === 'Failed' || status === 'Blocked') return { state: 'failed', label: 'Could not be built', citedEvents: 0, syntheticEntries: 0 };
  if (fixture && (r.briefState === 'ready' || r.briefState === 'simulated')) return { state: 'simulated', label: 'Simulated / Demo complete', citedEvents: 0, syntheticEntries: synthetic };
  if (grounded && r.briefState === 'ready' && (!research || cited > 0)) return { state: 'ready', label: 'Ready', citedEvents: cited, syntheticEntries: synthetic };
  if (r.briefState === 'ready' || r.briefState === 'simulated') return { state: 'unverified', label: 'Completed — source not verified', citedEvents: 0, syntheticEntries: synthetic };
  return { state: 'building', label: 'Building…', citedEvents: 0, syntheticEntries: 0 };
}

// Display only server-screened listings; server assignment checks remain authoritative.
export function compactFacilityGroups(response: any): any[] {
  return (response?.services ?? []).map((g: any) => {
    const seen = new Set<string>();
    const facilities = (g.facilities ?? []).filter((f: any) => {
      if (!['backend_screened_listing', 'agent_screened_listing'].includes(f.screening) || !f.placeId || seen.has(f.placeId)) return false;
      seen.add(f.placeId); return true;
    }).slice(0, 3);
    return { ...g, facilities };
  });
}

export function responseMarkerAppearance(kind: 'incident' | 'facility') {
  const incident = kind === 'incident';
  const color = incident ? '#b91c1c' : '#1d4ed8';
  const shape = incident ? '<path d="M18 2L34 18 18 34 2 18Z"/>' : '<circle cx="18" cy="18" r="15"/>';
  const glyph = incident ? '<path d="M18 9v12" stroke="white" stroke-width="3"/><circle cx="18" cy="26" r="1.8" fill="white"/>'
    : '<path d="M10 27V11h16v16M8 27h20M14 15h2m4 0h2m-8 5h2m4 0h2M17 27v-4h2v4" fill="none" stroke="white" stroke-width="2"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><g fill="${color}" stroke="white" stroke-width="2">${shape}</g>${glyph}</svg>`;
  return { color, symbol: incident ? '◆' : '●', name: incident ? 'Incident' : 'Response facility',
    iconUrl: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg), zIndex: incident ? 1000 : 100 };
}

// Screen readability is independent of activity score and geographic incident footprint.
export function pulseMarkerScale(zoom: number, selected = false): number {
  return (zoom < 10 ? 16 : 14) + (selected ? 4 : 0);
}
export function pulseInitialFocus<T extends { lat: number; lng: number }>(points: T[]): T[] {
  const distanceKm = (a: T, b: T) => Math.hypot((a.lat-b.lat)*111.2,
    (a.lng-b.lng)*111.2*Math.cos((a.lat+b.lat)*Math.PI/360));
  let best: T[] = [];
  for (const point of points) {
    const group = points.filter(p => distanceKm(point,p) <= 25);
    if (group.length > best.length) best = group;
  }
  return best.length >= 2 ? best : points;
}
