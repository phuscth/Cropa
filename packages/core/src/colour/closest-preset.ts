import type { Preset } from '../presets/file.ts';
import { parseHex } from '../schema/color.ts';
import { distance2, hexToOklab } from './oklab.ts';
import type { Oklab } from './oklab.ts';

interface Weighted {
  lab: Oklab;
  weight: number;
}

/**
 * The colours a preset paints with, each weighted by its share: every colour layer
 * counts by its opacity, split evenly over its colours (gradient stops, mesh points,
 * the one colour of a solid or shape), times the colour's own alpha. Layers without
 * colours (noise, image, blur) are skipped. Weights add up to 1; empty when the preset
 * paints no colour.
 */
export function presetColours(preset: Preset): { hex: string; weight: number }[] {
  const out: { hex: string; weight: number }[] = [];
  for (const layer of preset.background.layers) {
    const hexes: string[] = [];
    if ('color' in layer) hexes.push(layer.color);
    if ('stops' in layer) hexes.push(...layer.stops.map((s) => s.color));
    if ('points' in layer) hexes.push(...layer.points.map((p) => p.color));
    const opacity = 'opacity' in layer ? (layer.opacity ?? 1) : 1;
    for (const hex of hexes) {
      const alpha = parseHex(hex)?.a ?? 0;
      const weight = (opacity * alpha) / hexes.length;
      if (weight > 0) out.push({ hex: hex.slice(0, 7).toLowerCase(), weight });
    }
  }
  const total = out.reduce((sum, c) => sum + c.weight, 0);
  return out.map((c) => ({ hex: c.hex, weight: c.weight / total }));
}

function toWeighted(colours: readonly { hex: string; weight: number }[]): Weighted[] {
  const parsed = colours.flatMap((c) => {
    const lab = hexToOklab(c.hex);
    return lab && Number.isFinite(c.weight) && c.weight > 0 ? [{ lab, weight: c.weight }] : [];
  });
  const total = parsed.reduce((sum, c) => sum + c.weight, 0);
  return parsed.map((c) => ({ lab: c.lab, weight: c.weight / total }));
}

/** Weighted mean, over `from`, of the OKLab distance from each colour to its nearest in `to`. */
function reach(from: Weighted[], to: Weighted[]): number {
  let sum = 0;
  for (const p of from) {
    let best = Infinity;
    for (const q of to) best = Math.min(best, distance2(p.lab, q.lab));
    sum += p.weight * Math.sqrt(best);
  }
  return sum;
}

/**
 * The id of the preset whose colours are closest to `palette`, or null when the palette
 * or every preset has no colour.
 *
 * The score is a symmetric, weighted nearest-colour distance in OKLab: each palette
 * colour is matched to its nearest preset colour and each preset colour to its nearest
 * palette colour, distances are averaged by weight, and the two directions are averaged.
 * Matching by nearest colour makes the score independent of the order of either list,
 * the weights make the dominant colours count most, and taking both directions stops a
 * preset from winning by holding the palette's colours plus many unrelated ones (or by
 * covering only one of them). OKLab distance tracks perceived difference closely enough
 * for ranking. Ties go to the smallest id, so the result does not depend on the order of
 * `presets`.
 */
export function closestPreset(
  palette: readonly { hex: string; weight: number }[],
  presets: readonly Preset[],
): string | null {
  const target = toWeighted(palette);
  if (target.length === 0) return null;
  let bestId: string | null = null;
  let bestScore = Infinity;
  for (const preset of presets) {
    const colours = toWeighted(presetColours(preset));
    if (colours.length === 0) continue;
    const score = (reach(target, colours) + reach(colours, target)) / 2;
    if (score < bestScore || (score === bestScore && bestId !== null && preset.id < bestId)) {
      bestScore = score;
      bestId = preset.id;
    }
  }
  return bestId;
}
