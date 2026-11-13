import { BUILTIN_IMAGES, defaultScene, type BackgroundSpec } from '@cropa/core';

import { CAPTURE_REF, setBackgroundImage } from '../scene-edits.ts';

export interface ImagePreset {
  id: string;
  /** The `editor.background.images` key of its name: `capture` or one of the built-in names. */
  nameKey: string;
  background: BackgroundSpec;
}

/**
 * The screenshot backdrop and the built-in pictures as presets. Each background is what
 * picking that image in the manual controls makes from a plain background, so the two match
 * when the pick starts from a plain background (an animated one keeps its animation there).
 */
export function imagePresets(): ImagePreset[] {
  const plain = defaultScene({ width: 160, height: 100 });
  const entries = [
    { id: 'image-capture', nameKey: 'capture', ref: CAPTURE_REF },
    ...BUILTIN_IMAGES.map((name) => ({
      id: `image-${name}`,
      nameKey: `names.${name}`,
      ref: `builtin:${name}`,
    })),
  ];
  return entries.map(({ id, nameKey, ref }) => ({
    id,
    nameKey,
    background: setBackgroundImage(plain, ref).background,
  }));
}
