import { applyPlatformSize, defaultScene, outputSize, type Scene } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import { captureFileStem, EXPORT_SIZES, exportPlan } from './plan.ts';

describe('exportPlan', () => {
  const scene = defaultScene({ width: 800, height: 600 });
  const withAspect = (aspectRatio: [number, number]): Scene => ({
    ...scene,
    output: { ...scene.output, aspectRatio },
  });

  it('picks the mime type and quality of each format', () => {
    expect(exportPlan(scene, 'png', '1x')).toMatchObject({ mime: 'image/png', quality: undefined });
    expect(exportPlan(scene, 'jpeg', '1x')).toMatchObject({ mime: 'image/jpeg', quality: 0.92 });
    expect(exportPlan(scene, 'webp', '1x')).toMatchObject({ mime: 'image/webp', quality: 0.92 });
  });

  it('gives the exact K sizes of a 16:9 scene', () => {
    const wide = withAspect([16, 9]);
    expect(exportPlan(wide, 'png', '2k')).toMatchObject({ width: 2560, height: 1440 });
    expect(exportPlan(wide, 'png', '4k')).toMatchObject({ width: 3840, height: 2160 });
    expect(exportPlan(wide, 'png', '6k')).toMatchObject({ width: 6144, height: 3456 });
  });

  it('puts the long edge on the longer side of square and portrait scenes', () => {
    expect(exportPlan(withAspect([1, 1]), 'png', '2k')).toMatchObject({ width: 2560, height: 2560 });
    expect(exportPlan(withAspect([9, 16]), 'png', '2k')).toMatchObject({ width: 1440, height: 2560 });
  });

  it('reaches 2560 exactly from a natural 1093 x 615 canvas', () => {
    const natural = defaultScene({ width: 1093, height: 615 });
    const flat: Scene = { ...natural, frame: { ...natural.frame, padding: 0, inset: 0, border: null } };
    expect(exportPlan(flat, 'png', '1x')).toMatchObject({ width: 1093, height: 615 });
    expect(exportPlan(flat, 'png', '2k')).toMatchObject({ width: 2560, height: 1440 });
  });

  it('keeps 1x at the size of the canvas', () => {
    const plan = exportPlan(scene, 'png', '1x');
    expect({ width: plan.width, height: plan.height }).toEqual(outputSize(scene, 1));
  });

  it('exports a platform size at exactly that size, whatever the choice', () => {
    const facebook = applyPlatformSize(scene, 'facebook');
    for (const size of EXPORT_SIZES) {
      expect(exportPlan(facebook, 'png', size)).toMatchObject({ width: 1440, height: 1800 });
    }
  });
});

describe('captureFileStem', () => {
  it('pads every field and uses local time', () => {
    expect(captureFileStem(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe(
      'Cropa 2026-01-02 03.04.05',
    );
  });
});
