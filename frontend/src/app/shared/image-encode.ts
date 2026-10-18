/** Re-encode any browser-decodable image (JPEG/PNG/WebP/…) to a JPEG ≤ maxEdge px — the same output as the camera path. */
export async function toJpeg(file: Blob, maxEdge = 1600, quality = 0.85): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('decode')); i.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, fail) => c.toBlob(b => (b ? ok(b) : fail(new Error('encode'))), 'image/jpeg', quality));
  } finally { URL.revokeObjectURL(url); }
}
