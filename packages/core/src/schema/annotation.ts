import { z } from 'zod';

import { Hex } from './color.ts';
import { parseWith, upgrade } from './migrate.ts';
import type { MigrateResult, UpgradeStep } from './migrate.ts';

export const ANNOTATION_VERSION = 1;

const px = z.number().min(-1000000).max(1000000);

/**
 * A mark drawn over the screenshot, in pixels of the original image. Omitted style
 * fields fall back to the renderer's defaults.
 *
 * - `arrow`: tail at (x, y), tip at (x + width, y + height). Direction is kept.
 * - `rect`: the box outline, optionally filled and with rounded corners.
 * - `text`: `text` (lines split on newlines) anchored at the box's top-left corner;
 *   the block grows to fit the text and is at least as large as the box.
 * - `step`: a numbered circle centred in the box. `text` overrides the automatic
 *   number (the 1-based position among the scene's steps).
 * - `blur`, `pixelate`: replace the screenshot pixels under the box.
 *
 * For every type except `arrow` the box is normalised, so negative width or height
 * describes the same rectangle.
 */
export const Annotation = z.strictObject({
  version: z.literal(ANNOTATION_VERSION),
  type: z.enum(['arrow', 'rect', 'text', 'step', 'blur', 'pixelate']),
  /** x, y, width, height in pixels of the original image. Width and height may be negative. */
  box: z.tuple([px, px, px, px]),
  text: z.string().max(2000).optional(),
  style: z
    .strictObject({
      /** Stroke of an arrow or rect, text colour, fill of a step circle. */
      color: Hex.optional(),
      /** Line width of an arrow or rect, in image pixels. */
      strokeWidth: z.number().min(0.5).max(64).optional(),
      /** Font size of text, in image pixels. */
      fontSize: z.number().min(4).max(512).optional(),
      /** Fill of a rect, background pill of a text. */
      fill: Hex.optional(),
      /** Corner radius of a rect, in image pixels. */
      radius: z.number().min(0).max(4096).optional(),
      /** Blur radius or pixelate block size, in image pixels. */
      strength: z.number().min(1).max(256).optional(),
    })
    .optional(),
});
export type Annotation = z.infer<typeof Annotation>;

/** `steps[v]` upgrades version `v` to `v + 1`. Empty until a second version exists. */
const steps: Record<number, UpgradeStep> = {};

export function migrateAnnotation(input: unknown): MigrateResult<Annotation> {
  const upgraded = upgrade(input, ANNOTATION_VERSION, steps);
  if (!upgraded.ok) return upgraded;
  return parseWith(Annotation, upgraded.value);
}
