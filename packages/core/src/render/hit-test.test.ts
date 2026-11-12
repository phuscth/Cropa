import { describe, expect, it } from 'vitest';

import type { Annotation } from '../schema/annotation.ts';
import { defaultScene } from '../schema/scene.ts';
import { annotationBounds, hitTest } from './hit-test.ts';

function mark(type: Annotation['type'], box: Annotation['box'], style?: Annotation['style']): Annotation {
  return { version: 1, type, box, ...(style ? { style } : {}) };
}

function sceneOf(...annotations: Annotation[]) {
  return { ...defaultScene({ width: 400, height: 300 }), annotations };
}

describe('annotationBounds', () => {
  it('normalises a negative box for a rect and grows it by half the stroke', () => {
    expect(annotationBounds(mark('rect', [100, 80, -40, -20], { strokeWidth: 6 }))).toEqual({
      x: 57,
      y: 57,
      w: 46,
      h: 26,
    });
  });

  it('uses the default stroke width when the style has none', () => {
    expect(annotationBounds(mark('rect', [10, 10, 20, 20]))).toEqual({ x: 8, y: 8, w: 24, h: 24 });
  });

  it('covers both ends and the head of an arrow, whatever its direction', () => {
    const b = annotationBounds(mark('arrow', [100, 100, -60, 30], { strokeWidth: 4 }));
    for (const p of [
      { x: 100, y: 100 },
      { x: 40, y: 130 },
    ]) {
      expect(p.x).toBeGreaterThanOrEqual(b.x);
      expect(p.x).toBeLessThanOrEqual(b.x + b.w);
      expect(p.y).toBeGreaterThanOrEqual(b.y);
      expect(p.y).toBeLessThanOrEqual(b.y + b.h);
    }
    expect(b.w).toBeGreaterThan(60);
    expect(b.h).toBeGreaterThan(30);
  });

  it.each(['blur', 'pixelate'] as const)('is the normalised box for %s', (type) => {
    expect(annotationBounds(mark(type, [50, 60, -20, -10]))).toEqual({ x: 30, y: 50, w: 20, h: 10 });
  });

  it('is the drawn circle for a step, also for a zero or non-square box', () => {
    expect(annotationBounds(mark('step', [100, 100, 0, 0]))).toEqual({ x: 84, y: 84, w: 32, h: 32 });
    expect(annotationBounds(mark('step', [100, 100, 40, 20]))).toEqual({ x: 110, y: 100, w: 20, h: 20 });
  });

  it('grows a text block to fit its text', () => {
    const text = { ...mark('text', [10, 8, 0, 0], { fontSize: 20 }), text: 'abcde\nfg' };
    // Estimate: 5 chars * 0.6 * 20 = 60 wide plus 2 * 10 padding; 2 lines * 25 plus 2 * 5.
    expect(annotationBounds(text)).toEqual({ x: 10, y: 8, w: 80, h: 60 });
    expect(annotationBounds(text, () => 100)).toEqual({ x: 10, y: 8, w: 120, h: 60 });
  });
});

describe('hitTest', () => {
  it('returns null when nothing is under the point', () => {
    expect(hitTest(sceneOf(mark('rect', [10, 10, 20, 20])), { x: 200, y: 200 })).toBeNull();
    expect(hitTest(sceneOf(), { x: 1, y: 1 })).toBeNull();
  });

  it('picks the topmost of overlapping annotations', () => {
    const scene = sceneOf(mark('rect', [0, 0, 100, 100], { fill: '#00000022' }), mark('text', [20, 20, 40, 40]));
    expect(hitTest(scene, { x: 30, y: 30 })).toBe(1);
    expect(hitTest(scene, { x: 90, y: 90 })).toBe(0);
  });

  it('lets an arrow drawn over a redaction win, whatever the array order', () => {
    const blur = mark('blur', [0, 0, 200, 200]);
    const arrow = mark('arrow', [20, 100, 160, 0], { strokeWidth: 8 });
    expect(hitTest(sceneOf(blur, arrow), { x: 100, y: 100 })).toBe(1);
    expect(hitTest(sceneOf(arrow, blur), { x: 100, y: 100 })).toBe(0);
    expect(hitTest(sceneOf(arrow, blur), { x: 100, y: 150 })).toBe(1);
  });

  it('prefers the later of two redactions', () => {
    const scene = sceneOf(mark('blur', [0, 0, 100, 100]), mark('pixelate', [0, 0, 100, 100]));
    expect(hitTest(scene, { x: 50, y: 50 })).toBe(1);
  });

  it('misses a point inside an arrow bounding box but far from its line', () => {
    const scene = sceneOf(mark('arrow', [0, 0, 200, 200], { strokeWidth: 4 }));
    expect(hitTest(scene, { x: 100, y: 100 })).toBe(0);
    expect(hitTest(scene, { x: 180, y: 20 })).toBeNull();
  });

  it('hits the arrow head but not past its tip', () => {
    const scene = sceneOf(mark('arrow', [0, 0, 100, 0], { strokeWidth: 4 }));
    expect(hitTest(scene, { x: 85, y: 6 })).toBe(0);
    expect(hitTest(scene, { x: 105, y: 0 })).toBeNull();
  });

  it('hits a step only inside its circle', () => {
    const scene = sceneOf(mark('step', [100, 100, 40, 40]));
    expect(hitTest(scene, { x: 120, y: 120 })).toBe(0);
    expect(hitTest(scene, { x: 101, y: 101 })).toBeNull();
  });

  it('hits a text with a zero box inside its drawn label', () => {
    const text = { ...mark('text', [10, 8, 0, 0], { fontSize: 20 }), text: 'abcde' };
    const scene = sceneOf(text);
    expect(hitTest(scene, { x: 60, y: 25 })).toBe(0);
    expect(hitTest(scene, { x: 95, y: 25 })).toBeNull();
    // A measured width of 100 makes the label wider.
    expect(hitTest(scene, { x: 95, y: 25 }, { measure: () => 100 })).toBe(0);
  });

  it('hits an unfilled rect only on its outline and a filled one inside too', () => {
    const outline = mark('rect', [40, 40, 60, 60], { strokeWidth: 4 });
    const filled = mark('rect', [40, 40, 60, 60], { strokeWidth: 4, fill: '#00000033' });
    expect(hitTest(sceneOf(outline), { x: 40, y: 70 })).toBe(0);
    expect(hitTest(sceneOf(outline), { x: 70, y: 70 })).toBeNull();
    expect(hitTest(sceneOf(outline), { x: 70, y: 70 }, { tolerance: 30 })).toBe(0);
    expect(hitTest(sceneOf(filled), { x: 70, y: 70 })).toBe(0);
  });

  it('selects an annotation inside an unfilled rect', () => {
    const scene = sceneOf(mark('rect', [40, 40, 60, 60]), mark('blur', [50, 50, 40, 40]));
    expect(hitTest(scene, { x: 70, y: 70 })).toBe(1);
    expect(hitTest(scene, { x: 40, y: 70 })).toBe(0);
  });

  it('widens every target by the tolerance', () => {
    const scene = sceneOf(mark('blur', [100, 100, 50, 50]), mark('arrow', [0, 0, 80, 0], { strokeWidth: 2 }));
    expect(hitTest(scene, { x: 95, y: 125 })).toBeNull();
    expect(hitTest(scene, { x: 95, y: 125 }, { tolerance: 6 })).toBe(0);
    expect(hitTest(scene, { x: 40, y: 6 })).toBeNull();
    expect(hitTest(scene, { x: 40, y: 6 }, { tolerance: 6 })).toBe(1);
  });
});
