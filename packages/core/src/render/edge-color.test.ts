import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import type { Canvas2D } from './canvas.ts';
import { edgeColor } from './edge-color.ts';

const createContext = (w: number, h: number): Canvas2D => createCanvas(w, h).getContext('2d');

function parse(hex: string | null): [number, number, number] {
  if (hex === null) throw new Error('expected a colour');
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

describe('edgeColor', () => {
  it('returns the edge colour exactly, ignoring a busy interior', () => {
    const canvas = createCanvas(40, 30);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f4f4f5';
    ctx.fillRect(0, 0, 40, 30);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(5, 5, 20, 10);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(15, 10, 20, 15);
    expect(edgeColor(canvas, createContext)).toBe('#f4f4f5');
  });

  it('takes the most common edge colour, not the mean', () => {
    const canvas = createCanvas(100, 100);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#204060';
    ctx.fillRect(0, 0, 100, 100);
    // 30 of the 100 top-row pixels, and nothing else, use the second colour.
    ctx.fillStyle = '#e0a020';
    ctx.fillRect(0, 0, 30, 1);
    expect(edgeColor(canvas, createContext)).toBe('#204060');
  });

  it('averages small noise around the dominant colour', () => {
    const canvas = createCanvas(50, 50);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#6496c8';
    ctx.fillRect(0, 0, 50, 50);
    for (let i = 0; i < 50; i += 1) {
      const d = (i % 5) - 2;
      ctx.fillStyle = `rgb(${100 + d},${150 - d},${200 + d})`;
      ctx.fillRect(i, 0, 1, 1);
      ctx.fillRect(i, 49, 1, 1);
    }
    const [r, g, b] = parse(edgeColor(canvas, createContext));
    expect(Math.abs(r - 100)).toBeLessThanOrEqual(2);
    expect(Math.abs(g - 150)).toBeLessThanOrEqual(2);
    expect(Math.abs(b - 200)).toBeLessThanOrEqual(2);
  });

  it('returns null for a transparent image', () => {
    expect(edgeColor(createCanvas(8, 8), createContext)).toBeNull();
  });

  it('works for a 1x1 image', () => {
    const canvas = createCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#123456';
    ctx.fillRect(0, 0, 1, 1);
    expect(edgeColor(canvas, createContext)).toBe('#123456');
  });
});
