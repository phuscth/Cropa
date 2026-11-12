import type { Annotation } from '../schema/annotation.ts';
import type { Scene } from '../schema/scene.ts';
import { ANNOTATION_DEFAULTS, normalizeBox } from './annotations.ts';
import type { CanvasImage, RenderEnv } from './canvas.ts';

export function isRedaction(a: Annotation): boolean {
  return a.type === 'blur' || a.type === 'pixelate';
}

/**
 * Returns a copy of the screenshot, at its own resolution, with every blur and
 * pixelate annotation applied in array order, or null when the scene has none.
 * The frame draws this copy instead of the original, so no original pixel under a
 * box reaches the output whatever the output scale or resampling.
 *
 * Both effects are computed in plain arithmetic on the pixels inside the box
 * (never `ctx.filter` or `drawImage` downscaling), so the WebView and Node give the
 * same result and the result depends on nothing outside the box. A small pixelate
 * block over large text can still be guessed; the strength is the user's choice.
 */
export function redactScreenshot(scene: Scene, env: RenderEnv): CanvasImage | null {
  const redactions = scene.annotations.filter(isRedaction);
  if (redactions.length === 0) return null;

  const { width, height } = scene.screenshot;
  const out = env.createContext(width, height);
  out.drawImage(env.screenshot, 0, 0, width, height);

  for (const a of redactions) {
    const b = normalizeBox(a.box);
    const x0 = Math.max(0, Math.floor(b.x));
    const y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(width, Math.ceil(b.x + b.w));
    const y1 = Math.min(height, Math.ceil(b.y + b.h));
    if (x1 <= x0 || y1 <= y0) continue;

    const region = out.getImageData(x0, y0, x1 - x0, y1 - y0);
    if (a.type === 'pixelate') {
      pixelate(region.data, region.width, region.height, a.style?.strength ?? ANNOTATION_DEFAULTS.pixelate);
    } else {
      blur(region.data, region.width, region.height, a.style?.strength ?? ANNOTATION_DEFAULTS.blur);
    }
    out.putImageData(region, x0, y0);
  }
  return out.canvas;
}

/**
 * Replaces each block by the exact mean of its pixels. A side of length `len`
 * is cut into round(len / block) blocks (at least one) of near-equal size, so there
 * is never a tiny last block that would keep an original pixel.
 */
export function pixelate(data: Uint8ClampedArray, w: number, h: number, block: number): void {
  const cols = blockEdges(w, block);
  const rows = blockEdges(h, block);
  for (let r = 0; r + 1 < rows.length; r += 1) {
    const ya = rows[r] ?? 0;
    const yb = rows[r + 1] ?? 0;
    for (let c = 0; c + 1 < cols.length; c += 1) {
      const xa = cols[c] ?? 0;
      const xb = cols[c + 1] ?? 0;
      const sum = [0, 0, 0, 0];
      for (let y = ya; y < yb; y += 1) {
        for (let x = xa; x < xb; x += 1) {
          const i = (y * w + x) * 4;
          for (let k = 0; k < 4; k += 1) sum[k] = (sum[k] ?? 0) + (data[i + k] ?? 0);
        }
      }
      const n = (yb - ya) * (xb - xa);
      const mean = sum.map((v) => Math.round(v / n));
      for (let y = ya; y < yb; y += 1) {
        for (let x = xa; x < xb; x += 1) {
          const i = (y * w + x) * 4;
          for (let k = 0; k < 4; k += 1) data[i + k] = mean[k] ?? 0;
        }
      }
    }
  }
}

function blockEdges(len: number, block: number): number[] {
  const n = Math.max(1, Math.round(len / block));
  const edges: number[] = [];
  for (let i = 0; i <= n; i += 1) edges.push(Math.round((i * len) / n));
  return edges;
}

/**
 * Three passes of a separable box blur, which approximates a Gaussian. Each pass
 * has radius max(2, round(strength / 2)), giving sigma of about strength / 2 for
 * strength 12 and up; the floor of 2 keeps even a one-pixel checker from
 * surviving a pass. Samples past the region edge repeat the edge pixel.
 */
export function blur(data: Uint8ClampedArray, w: number, h: number, strength: number): void {
  const radius = Math.max(2, Math.round(strength / 2));
  const buf = new Float32Array(data.length);
  buf.set(data);
  const line = new Float32Array(Math.max(w, h));
  for (let pass = 0; pass < 3; pass += 1) {
    boxBlurAxis(buf, w, h, 4, w * 4, radius, line); // horizontal
    boxBlurAxis(buf, h, w, w * 4, 4, radius, line); // vertical
  }
  for (let i = 0; i < data.length; i += 1) data[i] = Math.round(buf[i] ?? 0);
}

/** Blurs `lines` lines of `len` samples; `step` moves along a line, `lineStep` to the next one. */
function boxBlurAxis(
  buf: Float32Array,
  len: number,
  lines: number,
  step: number,
  lineStep: number,
  radius: number,
  line: Float32Array,
): void {
  const size = 2 * radius + 1;
  const last = len - 1;
  for (let l = 0; l < lines; l += 1) {
    for (let c = 0; c < 4; c += 1) {
      const base = l * lineStep + c;
      for (let i = 0; i < len; i += 1) line[i] = buf[base + i * step] ?? 0;
      let sum = 0;
      for (let j = -radius; j <= radius; j += 1) sum += line[Math.min(Math.max(j, 0), last)] ?? 0;
      buf[base] = sum / size;
      for (let i = 1; i < len; i += 1) {
        sum += (line[Math.min(i + radius, last)] ?? 0) - (line[Math.max(i - radius - 1, 0)] ?? 0);
        buf[base + i * step] = sum / size;
      }
    }
  }
}
