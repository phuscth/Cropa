import type { Scene } from '../schema/scene.ts';

export type PlatformId = 'x' | 'facebook' | 'linkedin' | 'threads';

export interface PlatformSize {
  id: PlatformId;
  /** The ratio as people name it, width first, for example `[16, 9]`. */
  aspect: readonly [number, number];
  /** Exported image size in pixels. */
  width: number;
  height: number;
}

/** The size each platform shows a single image in its feed at full resolution. */
export const PLATFORM_SIZES: Readonly<Record<PlatformId, PlatformSize>> = {
  x: { id: 'x', aspect: [16, 9], width: 1920, height: 1080 },
  facebook: { id: 'facebook', aspect: [4, 5], width: 1440, height: 1800 },
  linkedin: { id: 'linkedin', aspect: [1.91, 1], width: 1200, height: 627 },
  threads: { id: 'threads', aspect: [4, 5], width: 1440, height: 1800 },
};

export const PLATFORM_IDS: readonly PlatformId[] = ['x', 'facebook', 'linkedin', 'threads'];

/**
 * The scene framed for a platform: the background grows to the platform's
 * aspect ratio and the output is scaled to its pixel width. Export it at
 * scale 1 to get exactly `width` × `height`.
 */
export function applyPlatformSize(scene: Scene, id: PlatformId): Scene {
  const { width, height } = PLATFORM_SIZES[id];
  return {
    ...scene,
    // The exact pixel ratio, so the height comes out exact too.
    output: { aspectRatio: [width / height, 1], width },
  };
}
