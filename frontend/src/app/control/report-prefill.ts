// Control-room proposals only. These values never claim an observed event is verified.
export function reportPrefill(r: any) {
  const a = r?.result?.assessment ?? {}, s = r?.spec ?? {};
  const coords = Number.isFinite(s.latitude) && Number.isFinite(s.longitude)
    ? `${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)}` : '';
  return { category: a.suggestedCategory || s.categoryHint || 'other_uncertain',
    priority: ['P1','P2','P3','P4'].includes(a.suggestedPriority) ? a.suggestedPriority : a.urgencyHint ? 'P1' : 'P3',
    jurisdiction: coords, summary: a.observations || s.note || '',
    reason: 'Proposed group based on category, location and time; review the selected evidence before confirming.',
    prioritySource: ['P1','P2','P3','P4'].includes(a.suggestedPriority) ? 'AI suggested priority — advisory' : a.urgencyHint ? 'AI urgency cue — advisory, not dispatch' : 'P3 form default — urgency unknown',
    summarySource: a.observations ? 'AI interpretation — not independently verified' : s.note ? 'Reporter note — not independently verified' : 'No summary available',
    locationSource: coords ? `Reporter pin (${s.locationSource || 'source unknown'}); area name unknown` : 'Location unknown',
    services: (a.suggestedServices ?? []).filter((x: any) => typeof x?.service === 'string'),
  };
}
export function proposedPicks(candidates: any[], choices: Map<string, boolean>): string[] {
  return candidates.filter(c => c.kind === 'same_event' && !c.incidentId &&
    (choices.has(c.reportId) ? choices.get(c.reportId) : c.recommendedForGrouping === true)).map(c => c.reportId);
}
export function proposedTargets(candidates: any[]): any[] {
  const seen = new Set<string>();
  return candidates.filter(c => c.incidentId && c.recommendedForGrouping === true && !seen.has(c.incidentId) && !!seen.add(c.incidentId));
}
