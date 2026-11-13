import { describe, expect, it } from 'vitest';

import { builtinPresets } from '../presets/builtin.ts';
import type { Preset } from '../presets/file.ts';
import { closestPreset, presetColours } from './closest-preset.ts';
import { extractPalette } from './palette.ts';
import type { Pixels } from './palette.ts';

type Rgba = [number, number, number, number];

/** An image painted by `colourAt(x, y)`. */
function image(width: number, height: number, colourAt: (x: number, y: number) => Rgba): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(colourAt(x, y), (y * width + x) * 4);
  }
  return { data, width, height };
}

/** A screenshot-like image: a light page, a dark sidebar, a blue header, noisy text. */
function busy(width: number, height: number): Pixels {
  let s = 12345;
  const noise = () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s >>> 16) & 0x1f;
  };
  return image(width, height, (x, y) => {
    if (y < height / 10) return [37, 99, 235, 255];
    if (x < width / 5) return [17, 24, 39, 255];
    const n = noise();
    return y % 24 < 3 ? [60 + n, 60 + n, 70 + n, 255] : [245 - n / 4, 246, 248, 255];
  });
}

const RED: Rgba = [230, 57, 70, 255];
const TEAL: Rgba = [42, 157, 143, 255];

describe('extractPalette', () => {
  it('gives the same palette for the same image', () => {
    const pixels = busy(800, 500);
    expect(extractPalette(pixels)).toEqual(extractPalette(pixels));
  });

  it('finds the two colours of a two-colour image with weights near their area', () => {
    // 30% red on the left, 70% teal on the right; 1000 px wide so blocks straddle the edge.
    const palette = extractPalette(image(1000, 400, (x) => (x < 300 ? RED : TEAL)));
    const [first, second] = palette;
    expect(first?.hex).toBe('#2a9d8f');
    expect(second?.hex).toBe('#e63946');
    expect(first?.weight).toBeCloseTo(0.7, 1);
    expect(second?.weight).toBeCloseTo(0.3, 1);
    expect(palette.reduce((sum, c) => sum + c.weight, 0)).toBeCloseTo(1, 9);
  });

  it('returns exactly two colours when blocks align with the edge', () => {
    const palette = extractPalette(image(960, 480, (x) => (x < 480 ? RED : TEAL)));
    expect(palette).toEqual([
      { hex: '#2a9d8f', weight: 0.5 },
      { hex: '#e63946', weight: 0.5 },
    ]);
  });

  it('ignores fully transparent pixels', () => {
    // Three quarters transparent "red"; only the opaque teal quarter counts.
    const palette = extractPalette(
      image(400, 400, (x, y) => (x < 200 && y < 200 ? TEAL : [230, 57, 70, 0])),
    );
    expect(palette).toEqual([{ hex: '#2a9d8f', weight: 1 }]);
  });

  it('returns an empty palette for a fully transparent or empty image', () => {
    expect(extractPalette(image(50, 50, () => [255, 0, 0, 0]))).toEqual([]);
    expect(extractPalette({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toEqual([]);
  });

  it('gives one colour for a solid image', () => {
    expect(extractPalette(image(333, 211, () => [18, 52, 86, 255]))).toEqual([
      { hex: '#123456', weight: 1 },
    ]);
  });

  it('merges near-duplicate clusters', () => {
    // Two greys one step apart are one colour to the eye.
    const palette = extractPalette(image(200, 200, (x) => (x < 100 ? [128, 128, 128, 255] : [130, 130, 130, 255])));
    expect(palette).toHaveLength(1);
  });

  it('rejects a buffer smaller than its size', () => {
    expect(() =>
      extractPalette({ data: new Uint8ClampedArray(10), width: 10, height: 10 }),
    ).toThrow(RangeError);
  });

  it('handles a 1920x1080 image well within the time budget', () => {
    const pixels = busy(1920, 1080);
    extractPalette(pixels);
    const start = performance.now();
    const palette = extractPalette(pixels);
    const elapsed = performance.now() - start;
    expect(palette.length).toBeGreaterThan(1);
    // The target is about 30 ms; the bound is loose so a busy CI machine does not flake.
    expect(elapsed).toBeLessThan(500);
  });
});

describe('closestPreset', () => {
  it('picks each built-in preset for a palette of its own colours', () => {
    const coloured = builtinPresets.filter((p) => presetColours(p).length > 0);
    expect(coloured.length).toBeGreaterThan(5);
    for (const preset of coloured) {
      // Reversed so the result cannot rely on the order the colours are listed in.
      const palette = presetColours(preset).reverse();
      expect(closestPreset(palette, builtinPresets), preset.id).toBe(preset.id);
    }
  });

  it('picks the obvious preset for a screenshot-like palette', () => {
    const dark = [
      { hex: '#0c1128', weight: 0.6 },
      { hex: '#1f2b6a', weight: 0.4 },
    ];
    expect(closestPreset(dark, builtinPresets)).toBe('midnight');
    const warm = [
      { hex: '#ff8f7a', weight: 0.5 },
      { hex: '#ffc070', weight: 0.5 },
    ];
    expect(closestPreset(warm, builtinPresets)).toBe('sunset');
  });

  it('breaks ties by id, whatever the order of the presets', () => {
    const sunset = builtinPresets.find((p) => p.id === 'sunset') as Preset;
    const twin: Preset = { ...sunset, id: 'a-sunset-twin' };
    const palette = presetColours(sunset);
    expect(closestPreset(palette, [sunset, twin])).toBe('a-sunset-twin');
    expect(closestPreset(palette, [twin, sunset])).toBe('a-sunset-twin');
  });

  it('returns null when there is nothing to compare', () => {
    expect(closestPreset([], builtinPresets)).toBeNull();
    expect(closestPreset([{ hex: '#ffffff', weight: 1 }], [])).toBeNull();
  });
});
