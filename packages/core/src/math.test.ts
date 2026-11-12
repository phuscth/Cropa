import { describe, expect, it } from 'vitest';

import { clamp } from './math.ts';

describe('clamp', () => {
  it('keeps values inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('pins values to the nearest bound', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(Infinity, 0, 10)).toBe(10);
  });

  it('maps NaN to the lower bound', () => {
    expect(clamp(Number.NaN, 2, 10)).toBe(2);
  });

  it('rejects an inverted range', () => {
    expect(() => clamp(1, 10, 0)).toThrow(RangeError);
  });
});
