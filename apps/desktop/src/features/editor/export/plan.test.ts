import { applyPlatformSize, defaultScene } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import { captureFileStem, exportPlan, MAX_EXPORT_SIDE } from './plan.ts';

describe('exportPlan', () => {
  const scene = defaultScene({ width: 800, height: 600 });

  it('picks the mime type and quality of each format', () => {
    expect(exportPlan(scene, 'png', 1)).toMatchObject({ mime: 'image/png', quality: undefined });
    expect(exportPlan(scene, 'jpeg', 1)).toMatchObject({ mime: 'image/jpeg', quality: 0.92 });
    expect(exportPlan(scene, 'webp', 1)).toMatchObject({ mime: 'image/webp', quality: 0.92 });
  });

  it('doubles the size at scale 2', () => {
    const one = exportPlan(scene, 'png', 1);
    const two = exportPlan(scene, 'png', 2);
    expect(two.scale).toBe(2);
    expect(two.width).toBe(one.width * 2);
    expect(two.height).toBe(one.height * 2);
  });

  it('exports a platform size at exactly that size, whatever the scale', () => {
    const facebook = applyPlatformSize(scene, 'facebook');
    expect(exportPlan(facebook, 'png', 2)).toMatchObject({ width: 1440, height: 1800, scale: 1 });
  });

  it('lowers the scale so the longest side stays within the limit', () => {
    const large = defaultScene({ width: 10000, height: 6000 });
    const plan = exportPlan(large, 'png', 2);
    expect(plan.scale).toBeLessThan(2);
    expect(Math.max(plan.width, plan.height)).toBeLessThanOrEqual(MAX_EXPORT_SIDE);
  });
});

describe('captureFileStem', () => {
  it('pads every field and uses local time', () => {
    expect(captureFileStem(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe(
      'Cropa 2026-01-02 03.04.05',
    );
  });
});
