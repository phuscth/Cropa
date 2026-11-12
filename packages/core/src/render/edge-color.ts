import type { Canvas2D, CanvasImage } from './canvas.ts';

interface Bucket {
  count: number;
  r: number;
  g: number;
  b: number;
}

const hex = (n: number) => n.toString(16).padStart(2, '0');

/**
 * The colour found along the 1-pixel border of `image` (`#rrggbb`), or null when
 * every border pixel is mostly transparent. Reads only the four edge strips, never
 * the whole image. Pixels are bucketed by the top 4 bits of each channel; the
 * fullest bucket wins (the first one reached on a tie) and its mean is returned.
 */
export function edgeColor(
  image: CanvasImage,
  createContext: (width: number, height: number) => Canvas2D,
): string | null {
  const { width: w, height: h } = image;
  // Source rect and size of each strip: top row, bottom row, left column, right column.
  const strips: [number, number, number, number][] = [
    [0, 0, w, 1],
    [0, h - 1, w, 1],
    [0, 0, 1, h],
    [w - 1, 0, 1, h],
  ];

  const buckets = new Map<number, Bucket>();
  for (const [sx, sy, sw, sh] of strips) {
    const ctx = createContext(sw, sh);
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    const { data } = ctx.getImageData(0, 0, sw, sh);
    for (let i = 0; i + 3 < data.length; i += 4) {
      if ((data[i + 3] ?? 0) < 128) continue;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.count += 1;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
      } else {
        buckets.set(key, { count: 1, r, g, b });
      }
    }
  }

  let best: Bucket | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  const chosen: Bucket | null = best;
  if (!chosen) return null;
  const mean = (sum: number) => hex(Math.round(sum / chosen.count));
  return `#${mean(chosen.r)}${mean(chosen.g)}${mean(chosen.b)}`;
}
