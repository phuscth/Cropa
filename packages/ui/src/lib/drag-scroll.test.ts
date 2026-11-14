import { describe, expect, it } from 'vitest';

import { isDrag, restingScroll } from './drag-scroll.ts';

describe('isDrag', () => {
  it('keeps a press that moved up to the threshold a click', () => {
    expect(isDrag(0, 0)).toBe(false);
    expect(isDrag(5, 0)).toBe(false);
    expect(isDrag(-3, 4)).toBe(false);
  });

  it('turns a press that moved past the threshold into a drag, in any direction', () => {
    expect(isDrag(6, 0)).toBe(true);
    expect(isDrag(-6, 0)).toBe(true);
    expect(isDrag(4, 4)).toBe(true);
    expect(isDrag(0, 6)).toBe(true);
  });
});

describe('restingScroll', () => {
  const snaps = [0, 208, 416, 624];

  it('settles on the nearest snap point when let go without speed', () => {
    expect(restingScroll(90, 0, snaps, 700)).toBe(0);
    expect(restingScroll(120, 0, snaps, 700)).toBe(208);
  });

  it('carries a flick further in the direction the pointer moved', () => {
    // Pointer moving left scrolls the row forward.
    expect(restingScroll(120, -1, snaps, 700)).toBe(208);
    expect(restingScroll(120, -2, snaps, 700)).toBe(416);
    // Pointer moving right scrolls it back.
    expect(restingScroll(300, 1.5, snaps, 700)).toBe(0);
  });

  it('never rests past either end of the row', () => {
    expect(restingScroll(600, -5, snaps, 560)).toBe(560);
    expect(restingScroll(10, 5, [], 560)).toBe(0);
  });

  it('rests where the glide ends when the row has no snap points', () => {
    expect(restingScroll(100, -0.5, [], 560)).toBe(180);
  });
});
