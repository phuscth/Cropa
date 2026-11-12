import { z } from 'zod';

import { Hex } from './color.ts';
import { parseWith, upgrade } from './migrate.ts';
import type { MigrateResult, UpgradeStep } from './migrate.ts';

export const ANNOTATION_VERSION = 1;

const px = z.number().min(-1000000).max(1000000);

/** Stored and validated; the renderer does not draw annotations yet. */
export const Annotation = z.strictObject({
  version: z.literal(ANNOTATION_VERSION),
  type: z.enum(['arrow', 'rect', 'text', 'step', 'blur', 'pixelate']),
  /** x, y, width, height in pixels of the original image. Width and height may be negative (arrow direction). */
  box: z.tuple([px, px, px, px]),
  text: z.string().max(2000).optional(),
  style: z
    .strictObject({
      color: Hex.optional(),
      strokeWidth: z.number().min(0.5).max(64).optional(),
      fontSize: z.number().min(4).max(512).optional(),
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
