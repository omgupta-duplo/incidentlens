/**
 * Minimal EXIF reader for uploaded JPEGs: DateTimeOriginal and GPS position only. Used as HINTS (shown to the
 * reporter and stored as `exifTakenAt` / `exifLatitude/Longitude`) — never as proof or as the confirmed pin.
 * Returns {} for non-JPEG files or files without EXIF. No dependencies; never throws.
 */
export interface ExifHints { takenAt?: string; lat?: number; lng?: number }

export function readExif(buf: ArrayBuffer): ExifHints {
  try {
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return {};
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off), size = v.getUint16(off + 2);
      if (marker === 0xffe1 && size >= 8 && v.getUint32(off + 4) === 0x45786966) return tiff(v, off + 10);   // "Exif"
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return {};                                      // SOS: no EXIF
      off += 2 + size;
    }
  } catch { /* malformed → no hints */ }
  return {};
}

function tiff(v: DataView, t: number): ExifHints {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (o: number) => v.getUint16(t + o, le), u32 = (o: number) => v.getUint32(t + o, le);
  const entries = (ifd: number) => {
    const n = u16(ifd), out = new Map<number, { type: number; count: number; valOff: number }>();
    for (let i = 0; i < n && i < 200; i++) {
      const e = ifd + 2 + i * 12;
      out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valOff: e + 8 });
    }
    return out;
  };
  const ascii = (en?: { count: number; valOff: number }) => {
    if (!en) return undefined;
    const at = en.count > 4 ? u32(en.valOff) : en.valOff;
    let s = ''; for (let i = 0; i < en.count - 1 && i < 64; i++) s += String.fromCharCode(v.getUint8(t + at + i));
    return s;
  };
  const rationals = (en?: { count: number; valOff: number }) => {
    if (!en || en.count < 3) return undefined;
    const at = u32(en.valOff), r = (k: number) => { const d = u32(at + k * 8 + 4); return d ? u32(at + k * 8) / d : NaN; };
    return r(0) + r(1) / 60 + r(2) / 3600;
  };
  const ifd0 = entries(u32(4)), hints: ExifHints = {};
  const exifPtr = ifd0.get(0x8769), gpsPtr = ifd0.get(0x8825);
  const raw = (exifPtr && ascii(entries(u32(exifPtr.valOff)).get(0x9003))) || ascii(ifd0.get(0x0132));
  const m = raw?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);    // EXIF has no zone → device local time
    if (!isNaN(d.getTime()) && +m[1] > 1990) hints.takenAt = d.toISOString();
  }
  if (gpsPtr) {
    const g = entries(u32(gpsPtr.valOff));
    let lat = rationals(g.get(2)), lng = rationals(g.get(4));
    if (ascii(g.get(1)) === 'S' && lat != null) lat = -lat;
    if (ascii(g.get(3)) === 'W' && lng != null) lng = -lng;
    if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) {
      hints.lat = Math.round(lat * 1e6) / 1e6; hints.lng = Math.round(lng * 1e6) / 1e6;
    }
  }
  return hints;
}
