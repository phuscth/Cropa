import { parseHex } from '../schema/color.ts';

/** A colour in OKLab: `l` is lightness (0..1), `a` and `b` the opponent axes. */
export interface Oklab {
  l: number;
  a: number;
  b: number;
}

function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toGamma(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** Linear-light value of each 8-bit sRGB channel value. */
export const SRGB_TO_LINEAR: Float64Array = Float64Array.from({ length: 256 }, (_, i) =>
  toLinear(i / 255),
);

/** OKLab of a linear-light sRGB colour (channels 0..1). */
export function linearToOklab(r: number, g: number, b: number): Oklab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** `#rrggbb` of an OKLab colour; colours outside sRGB are clipped per channel. */
export function oklabToHex({ l, a, b }: Oklab): string {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return `#${linear
    .map((c) => {
      const byte = Math.round(toGamma(Math.min(1, Math.max(0, c))) * 255);
      return byte.toString(16).padStart(2, '0');
    })
    .join('')}`;
}

/** OKLab of a `#rrggbb[aa]` string (alpha is ignored), or null when it does not parse. */
export function hexToOklab(hex: string): Oklab | null {
  const rgba = parseHex(hex);
  if (!rgba) return null;
  return linearToOklab(
    SRGB_TO_LINEAR[rgba.r] ?? 0,
    SRGB_TO_LINEAR[rgba.g] ?? 0,
    SRGB_TO_LINEAR[rgba.b] ?? 0,
  );
}

/** Squared Euclidean distance in OKLab. */
export function distance2(p: Oklab, q: Oklab): number {
  const dl = p.l - q.l;
  const da = p.a - q.a;
  const db = p.b - q.b;
  return dl * dl + da * da + db * db;
}
