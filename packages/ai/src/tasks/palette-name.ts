import { z } from 'zod';

import { defineTask } from '../task.ts';

export interface PaletteNameInput {
  /** `#rgb` or `#rrggbb`. */
  colors: readonly string[];
}

export interface PaletteName {
  name: string;
  mood: string;
}

const NAME_MAX = 32;
const MOOD_MAX = 24;
const EMPTY_PALETTE: PaletteName = { name: 'Neutral Palette', mood: 'calm' };

const Output = z.object({
  name: z.string().describe('A name for the palette, 2-4 words'),
  mood: z.string().describe('The mood of the palette, one word'),
});

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function expand(digits: string): string {
  return digits.length === 3 ? Array.from(digits, (c) => c + c).join('') : digits;
}

function parseColor(color: string): Hsl | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  const digits = m?.[1];
  if (digits === undefined) return null;
  const full = expand(digits);
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

/** `#rrggbb`, lower case; null when the colour is not valid. */
function normalizeColor(color: string): string | null {
  const hsl = parseColor(color);
  if (hsl === null) return null;
  const digits = color.trim().slice(1).toLowerCase();
  const full = expand(digits);
  return `#${full}`;
}

const HUE_WORDS: readonly (readonly [number, string])[] = [
  [15, 'Red'],
  [45, 'Orange'],
  [70, 'Yellow'],
  [160, 'Green'],
  [200, 'Teal'],
  [255, 'Blue'],
  [290, 'Violet'],
  [335, 'Magenta'],
  [360, 'Red'],
];

function fallbackName(input: PaletteNameInput): PaletteName {
  const parsed = input.colors.flatMap((c) => parseColor(c) ?? []);
  if (parsed.length === 0) return EMPTY_PALETTE;

  const n = parsed.length;
  const l = parsed.reduce((sum, c) => sum + c.l, 0) / n;
  const s = parsed.reduce((sum, c) => sum + c.s, 0) / n;
  // A circular mean, so 350 and 10 degrees average to red, not cyan.
  const x = parsed.reduce((sum, c) => sum + Math.cos((c.h * Math.PI) / 180) * c.s, 0);
  const y = parsed.reduce((sum, c) => sum + Math.sin((c.h * Math.PI) / 180) * c.s, 0);
  const hue = (Math.atan2(y, x) * 180) / Math.PI;
  const h = (Math.round(hue) + 360) % 360;

  const hueWord = s < 0.08 ? 'Grey' : (HUE_WORDS.find(([max]) => h < max)?.[1] ?? 'Red');
  const tone = l > 0.7 ? 'Pale' : l < 0.35 ? 'Deep' : 'Soft';
  const mood = s > 0.6 ? 'vivid' : s < 0.25 ? 'muted' : 'calm';
  return { name: `${tone} ${hueWord}`, mood };
}

function clean(text: string, max: number): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();
}

export const paletteNameTask = defineTask({
  id: 'palette-name',
  version: 1,
  schema: Output,
  requires: [],
  buildPrompt(input: PaletteNameInput) {
    const colors = input.colors.flatMap((c) => normalizeColor(c) ?? []);
    return {
      system:
        'You name colour palettes. Reply with JSON only, matching the given schema. ' +
        'The name is 2-4 words; the mood is one word.',
      user: `Name this colour palette and give its mood: ${colors.join(', ')}`,
    };
  },
  postprocess(output, { input }): PaletteName {
    const fallback = fallbackName(input);
    return {
      name: clean(output.name, NAME_MAX) || fallback.name,
      mood: clean(output.mood, MOOD_MAX) || fallback.mood,
    };
  },
  fallback: fallbackName,
});
