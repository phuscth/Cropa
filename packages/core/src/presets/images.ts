import type { BackgroundSpec } from '../schema/background.ts';

/** The images that ship with the app, by name. A preset refers to one as `builtin:<name>`. */
export const BUILTIN_IMAGES = ['silk', 'dunes', 'bokeh', 'contour'] as const;
export type BuiltinImage = (typeof BUILTIN_IMAGES)[number];

/** The `builtin:` name the editor resolves to the screenshot itself. */
const CAPTURE_NAME = 'capture';

/** True when `name` is one of the images that ship with the app. */
export function isBuiltinImage(name: string): name is BuiltinImage {
  return (BUILTIN_IMAGES as readonly string[]).includes(name);
}

/**
 * What a preset in the community `presets/` folder may not do, one message per
 * problem. It may not hold a code layer, and its images must be the built-in ones or the screenshot: a contributor
 * cannot bring files, and a `user:` image exists on one computer only.
 */
export function communityPresetProblems(preset: { background: BackgroundSpec }): string[] {
  const problems: string[] = [];
  for (const [i, layer] of preset.background.layers.entries()) {
    if (layer.type === 'code') {
      problems.push(
        `background.layers.${i}: a code layer runs generated code; community presets must use the built-in layer types`,
      );
      continue;
    }
    if (layer.type !== 'image') continue;
    const path = `background.layers.${i}.ref`;
    const [scheme = '', name = ''] = layer.ref.split(':');
    if (scheme === 'user') {
      problems.push(`${path}: "${layer.ref}" is a user's own image; use a built-in image`);
    } else if (name !== CAPTURE_NAME && !isBuiltinImage(name)) {
      const allowed = [...BUILTIN_IMAGES, CAPTURE_NAME].map((n) => `builtin:${n}`).join(', ');
      problems.push(`${path}: "${layer.ref}" is not a built-in image (use ${allowed})`);
    }
  }
  return problems;
}
