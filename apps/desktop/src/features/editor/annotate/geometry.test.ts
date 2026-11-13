import { defaultScene } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import { imagePerCss, shotRectCss, toCss, toImage, type PreviewGeometry } from './geometry.ts';

describe('preview geometry', () => {
  const scene = defaultScene({ width: 400, height: 200 });
  const g: PreviewGeometry = {
    css: { width: 500, height: 300 },
    backing: { width: 750, height: 450 },
  };

  it('maps the screenshot corners to the image corners', () => {
    const r = shotRectCss(scene, g);
    const start = toImage(scene, g, { x: r.x, y: r.y });
    expect(start.x).toBeCloseTo(0, 6);
    expect(start.y).toBeCloseTo(0, 6);
    const end = toImage(scene, g, { x: r.x + r.w, y: r.y + r.h });
    expect(end.x).toBeCloseTo(400, 6);
    expect(end.y).toBeCloseTo(200, 6);
  });

  it('round-trips a point', () => {
    const p = { x: 123.5, y: 77.25 };
    const back = toCss(scene, g, toImage(scene, g, p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it('reports image pixels per CSS pixel', () => {
    expect(imagePerCss(scene, g)).toBeCloseTo(400 / shotRectCss(scene, g).w, 9);
  });
});
