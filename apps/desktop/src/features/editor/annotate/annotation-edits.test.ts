import { defaultScene, type Annotation, type Scene } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import {
  addAnnotation,
  createAnnotation,
  defaultToolStyle,
  duplicateAnnotation,
  handlesFor,
  moveAnnotation,
  removeAnnotation,
  resizeAnnotation,
  stepNumber,
} from './annotation-edits.ts';

const scene = (): Scene => defaultScene({ width: 800, height: 600 });
const style = defaultToolStyle({ width: 800, height: 600 });
const rect = (box: Annotation['box']): Annotation => ({ version: 1, type: 'rect', box });

describe('createAnnotation', () => {
  it('keeps the direction of an arrow dragged right to left', () => {
    const a = createAnnotation('arrow', { x: 100, y: 50 }, { x: 40, y: 80 }, style);
    expect(a.box).toEqual([100, 50, -60, 30]);
  });

  it('normalises a rect dragged up and to the left', () => {
    const a = createAnnotation('rect', { x: 100, y: 100 }, { x: 40, y: 30 }, style);
    expect(a.box).toEqual([40, 30, 60, 70]);
  });

  it('centres a step on the click with the style size', () => {
    const a = createAnnotation('step', { x: 200, y: 100 }, { x: 0, y: 0 }, style);
    const [x, y, w, h] = a.box;
    expect([w, h]).toEqual([style.stepSize, style.stepSize]);
    expect([x + w / 2, y + h / 2]).toEqual([200, 100]);
  });

  it('starts a text empty at the point', () => {
    const a = createAnnotation('text', { x: 12, y: 34 }, { x: 99, y: 99 }, style);
    expect(a).toMatchObject({ type: 'text', box: [12, 34, 0, 0], text: '' });
  });
});

describe('moveAnnotation', () => {
  it('shifts the box only', () => {
    const a = createAnnotation('arrow', { x: 10, y: 10 }, { x: 50, y: 30 }, style);
    expect(moveAnnotation(a, 5, -4)).toEqual({ ...a, box: [15, 6, 40, 20] });
  });
});

describe('resizeAnnotation', () => {
  it('grows a rect from its south-east handle', () => {
    const next = resizeAnnotation(rect([10, 10, 20, 20]), 'se', { x: 60, y: 50 });
    expect(next.box).toEqual([10, 10, 50, 40]);
  });

  it('flips a rect dragged past the opposite corner and stays normalised', () => {
    const next = resizeAnnotation(rect([10, 10, 20, 20]), 'nw', { x: 50, y: 60 });
    expect(next.box).toEqual([30, 30, 20, 30]);
  });

  it('moves the tip of an arrow and keeps the tail', () => {
    const a = createAnnotation('arrow', { x: 10, y: 10 }, { x: 50, y: 30 }, style);
    expect(resizeAnnotation(a, 'end', { x: 80, y: 90 }).box).toEqual([10, 10, 70, 80]);
    expect(resizeAnnotation(a, 'start', { x: 0, y: 0 }).box).toEqual([0, 0, 50, 30]);
  });

  it('keeps the centre of a step and stays square', () => {
    const a = createAnnotation('step', { x: 100, y: 100 }, { x: 100, y: 100 }, style);
    const [x, y, w, h] = resizeAnnotation(a, 'se', { x: 140, y: 120 }).box;
    expect(w).toBe(h);
    expect([x + w / 2, y + h / 2]).toEqual([100, 100]);
    expect(w).toBe(80);
  });

  it('offers the handles each type needs', () => {
    const point = { x: 5, y: 5 };
    expect(handlesFor(rect([0, 0, 10, 10]))).toHaveLength(8);
    expect(handlesFor(createAnnotation('arrow', { x: 0, y: 0 }, point, style))).toHaveLength(2);
    expect(handlesFor(createAnnotation('step', point, point, style))).toHaveLength(4);
    expect(handlesFor(createAnnotation('text', point, point, style))).toEqual([]);
  });
});

describe('step numbering', () => {
  const step = (x: number) => createAnnotation('step', { x, y: 50 }, { x, y: 50 }, style);
  const three = [step(10), step(100), step(200)].reduce(addAnnotation, scene());

  it('numbers steps in array order', () => {
    expect([0, 1, 2].map((i) => stepNumber(three, i))).toEqual([1, 2, 3]);
  });

  it('renumbers after a delete', () => {
    expect(stepNumber(removeAnnotation(three, 1), 1)).toBe(2);
  });

  it('gives a duplicated step the next number', () => {
    const copy = duplicateAnnotation(three, 0, 16);
    expect(copy.index).toBe(3);
    expect(stepNumber(copy.scene, copy.index)).toBe(4);
  });

  it('has no number for other types', () => {
    expect(stepNumber(addAnnotation(scene(), rect([0, 0, 5, 5])), 0)).toBeNull();
  });
});
