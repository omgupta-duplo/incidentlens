/** Empty coordinates stay empty; zero is a valid geographic coordinate. */
export function coordinateValue(value: unknown): number | null {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function completePin(lat: number | null, lng: number | null): { lat: number; lng: number } | null {
  return lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
/** Invalidates async image work on replacement, source switch, submit or component destruction. */
export class PhotoRevision {
  private value = 0;
  next(): number { return ++this.value; }
  current(revision: number): boolean { return revision === this.value; }
}
