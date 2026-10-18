/** Local, literal search over explicitly selected record fields. Never searches hidden owner data. */
export function matchesRecord(query: string, fields: unknown[]): boolean {
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const terms = normalize(query).split(' ').filter(Boolean);
  const text = fields.filter(x => typeof x === 'string' || typeof x === 'number').map(x => normalize(String(x))).join(' ');
  return terms.every(term => text.includes(term));
}
export function matchesEvidence(query: string, report: any, title: string, category: string): boolean {
  return matchesRecord(query, [report?.id, report?.name, title, category, report?.spec?.note,
    report?.spec?.categoryHint, report?.result?.assessment?.suggestedCategory,
    report?.result?.assessment?.observations]);
}
export function matchesPulse(query: string, area: string, incident: any, title: string): boolean {
  return matchesRecord(query, [incident?.id, incident?.name, title, incident?.category, incident?.summary,
    incident?.jurisdiction, incident?.priority, incident?.responseState]) && matchesRecord(area, [incident?.jurisdiction]);
}
