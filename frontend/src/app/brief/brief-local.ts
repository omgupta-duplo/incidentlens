export interface LocalArea { latitudeTile: number; longitudeTile: number; fromUtc: string; untilUtc: string; }
export function localAreaRequest(lat: string, lng: string, from: string, through: string, now = new Date()): LocalArea {
  if (!lat.trim() || !lng.trim()) throw new Error('Enter a point within the area to select its coarse tile.');
  const a = Number(lat), o = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(o) || a < -60 || a >= 60 || o < -180 || o >= 180)
    throw new Error('Use latitude from −60 to below 60 and longitude from −180 to below 180.');
  const parse = (s: string) => {
    const d = new Date(s + 'T00:00:00.000Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s)
      throw new Error('Choose valid start and end dates.');
    return d.getTime();
  };
  const f = parse(from), end = parse(through), day = 86400000;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (end < f || end - f >= 7 * day || f < today - 30 * day || end > today)
    throw new Error('Choose 1–7 UTC calendar days within the last 30 days, ending no later than today.');
  return { latitudeTile: Math.floor((a + 90) * 4), longitudeTile: Math.floor((o + 180) * 4),
    fromUtc: new Date(f).toISOString(), untilUtc: new Date(end + day).toISOString() };
}
export function localAreaLabel(s: LocalArea): string {
  if (!s || !Number.isInteger(s.latitudeTile) || !Number.isInteger(s.longitudeTile)) return 'Area not recorded';
  const south = s.latitudeTile / 4 - 90, west = s.longitudeTile / 4 - 180;
  return `${south.toFixed(2)}° to ${(south + .25).toFixed(2)}° latitude · ${west.toFixed(2)}° to ${(west + .25).toFixed(2)}° longitude`;
}
export function countBand(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+–\d+$/.test(value)) return 'Suppressed';
  const [lo, hi] = value.split('–').map(Number);
  return lo >= 5 && lo % 5 === 0 && hi === lo + 4 ? value : 'Suppressed';
}
