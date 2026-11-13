import { SRGB_TO_LINEAR, linearToOklab, oklabToHex } from './oklab.ts';
import type { Oklab } from './oklab.ts';

/** RGBA pixels, 4 bytes per pixel, row by row (the shape of canvas `ImageData`). */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PaletteColour {
  /** `#rrggbb` */
  hex: string;
  /** Share of the visible pixels (each counted by its alpha), 0..1; the weights add up to 1. */
  weight: number;
}

export interface PaletteOptions {
  /** Most colours to return, 1..16. Default 5. */
  k?: number;
  /** Long side of the downscaled image the clusters are computed on, 8..512. Default 96. */
  maxSide?: number;
}

const DEFAULT_K = 5;
const DEFAULT_MAX_SIDE = 96;
const MAX_ITERATIONS = 24;
/** Clusters closer than this in OKLab (about 1.5 just-noticeable differences) are merged. */
const MERGE_DISTANCE = 0.03;
const SEED = 0x9e3779b9;

interface Cluster extends Oklab {
  weight: number;
}

/**
 * The dominant colours of an image, heaviest first. Each pixel counts by its alpha, so
 * fully transparent pixels are left out and faint ones count little.
 * Deterministic: the same pixels always give the same palette.
 *
 * The image is box-averaged (in linear light, weighted by alpha) down to `maxSide` on its
 * long side, then the cells are clustered with weighted k-means in OKLab, seeded by
 * k-means++ from a fixed seed. Clusters closer than a small OKLab distance are merged.
 */
export function extractPalette(pixels: Pixels, opts: PaletteOptions = {}): PaletteColour[] {
  const k = opts.k ?? DEFAULT_K;
  const maxSide = opts.maxSide ?? DEFAULT_MAX_SIDE;
  if (!Number.isInteger(k) || k < 1 || k > 16) {
    throw new RangeError(`extractPalette: k must be an integer from 1 to 16, got ${k}`);
  }
  if (!Number.isInteger(maxSide) || maxSide < 8 || maxSide > 512) {
    throw new RangeError(
      `extractPalette: maxSide must be an integer from 8 to 512, got ${maxSide}`,
    );
  }
  const { data, width, height } = pixels;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`extractPalette: bad size ${width}x${height}`);
  }
  if (data.length < width * height * 4) {
    throw new RangeError(
      `extractPalette: ${width}x${height} needs ${width * height * 4} bytes, got ${data.length}`,
    );
  }

  const points = downscale(pixels, maxSide);
  if (points.weight.length === 0) return [];

  const clusters = merge(kmeans(points, k));
  const total = clusters.reduce((sum, c) => sum + c.weight, 0);
  return clusters
    .map((c) => ({ hex: oklabToHex(c), weight: c.weight / total }))
    .sort((p, q) => q.weight - p.weight || (p.hex < q.hex ? -1 : p.hex > q.hex ? 1 : 0));
}

interface Points {
  l: Float64Array;
  a: Float64Array;
  b: Float64Array;
  /** Summed alpha (0..1 per pixel) of the source pixels behind each point. */
  weight: Float64Array;
}

/** One OKLab point per non-empty block of `block x block` source pixels. */
function downscale({ data, width, height }: Pixels, maxSide: number): Points {
  const block = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  const cols = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const cells = cols * rows;
  const sumR = new Float64Array(cells);
  const sumG = new Float64Array(cells);
  const sumB = new Float64Array(cells);
  const sumA = new Float64Array(cells);

  for (let y = 0; y < height; y++) {
    const rowStart = Math.floor(y / block) * cols;
    let i = y * width * 4;
    for (let x = 0, cx = 0, cell = rowStart; x < width; x++, i += 4) {
      const alpha = data[i + 3] ?? 0;
      if (alpha !== 0) {
        const a = alpha / 255;
        sumR[cell] = (sumR[cell] ?? 0) + (SRGB_TO_LINEAR[data[i] ?? 0] ?? 0) * a;
        sumG[cell] = (sumG[cell] ?? 0) + (SRGB_TO_LINEAR[data[i + 1] ?? 0] ?? 0) * a;
        sumB[cell] = (sumB[cell] ?? 0) + (SRGB_TO_LINEAR[data[i + 2] ?? 0] ?? 0) * a;
        sumA[cell] = (sumA[cell] ?? 0) + a;
      }
      if (++cx === block) {
        cx = 0;
        cell++;
      }
    }
  }

  let n = 0;
  for (let c = 0; c < cells; c++) if ((sumA[c] ?? 0) > 0) n++;
  const points: Points = {
    l: new Float64Array(n),
    a: new Float64Array(n),
    b: new Float64Array(n),
    weight: new Float64Array(n),
  };
  for (let c = 0, p = 0; c < cells; c++) {
    const alpha = sumA[c] ?? 0;
    if (alpha === 0) continue;
    const lab = linearToOklab(
      (sumR[c] ?? 0) / alpha,
      (sumG[c] ?? 0) / alpha,
      (sumB[c] ?? 0) / alpha,
    );
    points.l[p] = lab.l;
    points.a[p] = lab.a;
    points.b[p] = lab.b;
    points.weight[p] = alpha;
    p++;
  }
  return points;
}

/** mulberry32: a small seeded generator, so seeding never depends on `Math.random`. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Index picked with probability proportional to `weights[i]`. */
function pick(weights: Float64Array, total: number, r: number): number {
  let target = r * total;
  for (let i = 0; i < weights.length; i++) {
    target -= weights[i] ?? 0;
    if (target < 0) return i;
  }
  // Rounding left a sliver at the end: take the last index with any weight.
  for (let i = weights.length - 1; i > 0; i--) if ((weights[i] ?? 0) > 0) return i;
  return 0;
}

function kmeans(points: Points, k: number): Cluster[] {
  const n = points.weight.length;
  const { l: pl, a: pa, b: pb, weight: pw } = points;
  const next = random(SEED);

  // k-means++ seeding, each point counted by its pixel weight. Seeding stops early when
  // every point already sits on a centre (fewer distinct colours than k).
  const centres: Oklab[] = [];
  const totalWeight = pw.reduce((sum, w) => sum + w, 0);
  const first = pick(pw, totalWeight, next());
  centres.push({ l: pl[first] ?? 0, a: pa[first] ?? 0, b: pb[first] ?? 0 });
  const nearest = new Float64Array(n).fill(Infinity);
  const score = new Float64Array(n);
  while (centres.length < k) {
    const last = centres[centres.length - 1] as Oklab;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dl = (pl[i] ?? 0) - last.l;
      const da = (pa[i] ?? 0) - last.a;
      const db = (pb[i] ?? 0) - last.b;
      const d = Math.min(nearest[i] ?? Infinity, dl * dl + da * da + db * db);
      nearest[i] = d;
      score[i] = d * (pw[i] ?? 0);
      total += score[i] ?? 0;
    }
    if (total <= 0) break;
    const chosen = pick(score, total, next());
    centres.push({ l: pl[chosen] ?? 0, a: pa[chosen] ?? 0, b: pb[chosen] ?? 0 });
  }

  // Lloyd iterations on the weighted points.
  const m = centres.length;
  const assign = new Int32Array(n).fill(-1);
  const sums = new Float64Array(m * 4);
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      const l = pl[i] ?? 0;
      const a = pa[i] ?? 0;
      const b = pb[i] ?? 0;
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < m; c++) {
        const centre = centres[c] as Oklab;
        const dl = l - centre.l;
        const da = a - centre.a;
        const db = b - centre.b;
        const d = dl * dl + da * da + db * db;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    if (!changed && iter > 0) break;

    sums.fill(0);
    for (let i = 0; i < n; i++) {
      const c = (assign[i] ?? 0) * 4;
      const w = pw[i] ?? 0;
      sums[c] = (sums[c] ?? 0) + (pl[i] ?? 0) * w;
      sums[c + 1] = (sums[c + 1] ?? 0) + (pa[i] ?? 0) * w;
      sums[c + 2] = (sums[c + 2] ?? 0) + (pb[i] ?? 0) * w;
      sums[c + 3] = (sums[c + 3] ?? 0) + w;
    }
    for (let c = 0; c < m; c++) {
      const w = sums[c * 4 + 3] ?? 0;
      if (w > 0) {
        centres[c] = {
          l: (sums[c * 4] ?? 0) / w,
          a: (sums[c * 4 + 1] ?? 0) / w,
          b: (sums[c * 4 + 2] ?? 0) / w,
        };
      }
    }
  }

  const weights = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    const c = assign[i] ?? 0;
    weights[c] = (weights[c] ?? 0) + (pw[i] ?? 0);
  }
  return centres
    .map((centre, c) => ({ ...centre, weight: weights[c] ?? 0 }))
    .filter((cluster) => cluster.weight > 0);
}

/** Merges the closest pair of clusters while they are nearer than `MERGE_DISTANCE`. */
function merge(clusters: Cluster[]): Cluster[] {
  const out = [...clusters];
  const limit = MERGE_DISTANCE * MERGE_DISTANCE;
  for (;;) {
    let bi = -1;
    let bj = -1;
    let bestD = limit;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const p = out[i] as Cluster;
        const q = out[j] as Cluster;
        const d = (p.l - q.l) ** 2 + (p.a - q.a) ** 2 + (p.b - q.b) ** 2;
        if (d < bestD) {
          bestD = d;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0) return out;
    const p = out[bi] as Cluster;
    const q = out[bj] as Cluster;
    const w = p.weight + q.weight;
    out[bi] = {
      l: (p.l * p.weight + q.l * q.weight) / w,
      a: (p.a * p.weight + q.a * q.weight) / w,
      b: (p.b * p.weight + q.b * q.weight) / w,
      weight: w,
    };
    out.splice(bj, 1);
  }
}
