import { describe, expect, it } from 'vitest';

import { outputSize } from '../render/layout.ts';
import { defaultScene, migrateScene } from '../schema/scene.ts';
import { applyPlatformSize, PLATFORM_IDS, PLATFORM_SIZES } from './platform-sizes.ts';

const SCREENSHOTS = [
  { width: 1920, height: 1080 },
  { width: 400, height: 1200 },
  { width: 3840, height: 2160 },
  { width: 32, height: 32 },
];

describe('applyPlatformSize', () => {
  for (const id of PLATFORM_IDS) {
    it(`exports exactly the ${id} size from any screenshot`, () => {
      const { width, height } = PLATFORM_SIZES[id];
      for (const shot of SCREENSHOTS) {
        const scene = applyPlatformSize(defaultScene(shot), id);
        expect(outputSize(scene, 1)).toEqual({ width, height });
        // Still a scene the schema accepts.
        expect(migrateScene(scene).ok).toBe(true);
      }
    });
  }

  it('keeps everything but the output', () => {
    const scene = defaultScene({ width: 800, height: 600 });
    const framed = applyPlatformSize(scene, 'linkedin');
    expect({ ...framed, output: scene.output }).toEqual(scene);
  });

  it('replaces an earlier platform instead of combining with it', () => {
    const scene = defaultScene({ width: 800, height: 600 });
    const twice = applyPlatformSize(applyPlatformSize(scene, 'facebook'), 'x');
    expect(twice).toEqual(applyPlatformSize(scene, 'x'));
  });
});

describe('PLATFORM_SIZES', () => {
  it('pixel sizes match their named aspect ratio within 0.5%', () => {
    for (const id of PLATFORM_IDS) {
      const { aspect, width, height } = PLATFORM_SIZES[id];
      expect(Math.abs(width / height / (aspect[0] / aspect[1]) - 1)).toBeLessThan(0.005);
    }
  });
});
