import { z } from 'zod';

import { Hex, Ref } from './color.ts';
import { parseWith, upgrade } from './migrate.ts';
import type { MigrateResult, UpgradeStep } from './migrate.ts';

export const BACKGROUND_VERSION = 1;

const num = (min: number, max: number) => z.number().min(min).max(max);
const coord = num(-100000, 100000);
const size = z.number().gt(0).max(100000);
// At least 1 so the renderer never maps a degenerate viewBox onto the canvas.
const viewSize = z.number().min(1).max(100000);
const opacity = num(0, 1).optional();
const angle = num(-360, 360);

const Stop = z.strictObject({ offset: num(0, 1), color: Hex });
const stops = z.array(Stop).min(2).max(16);

const Solid = z.strictObject({ type: z.literal('solid'), opacity, color: Hex });
const Linear = z.strictObject({ type: z.literal('linear'), opacity, angle, stops });
const Radial = z.strictObject({
  type: z.literal('radial'),
  opacity,
  cx: coord,
  cy: coord,
  r: size,
  stops,
});
const Conic = z.strictObject({
  type: z.literal('conic'),
  opacity,
  cx: coord,
  cy: coord,
  angle,
  stops,
});
const Mesh = z.strictObject({
  type: z.literal('mesh'),
  opacity,
  points: z
    .array(z.strictObject({ x: coord, y: coord, r: size, color: Hex }))
    .min(1)
    .max(12),
});
const Noise = z.strictObject({
  type: z.literal('noise'),
  opacity,
  grain: num(0.25, 20),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1),
});
const Shape = z.strictObject({
  type: z.literal('shape'),
  opacity,
  shape: z.enum(['ellipse', 'rect']),
  x: coord,
  y: coord,
  w: size,
  h: size,
  rotation: angle,
  color: Hex,
});
const ImageLayer = z.strictObject({
  type: z.literal('image'),
  opacity,
  ref: Ref,
  fit: z.enum(['cover', 'contain', 'stretch']),
});
/** Blurs everything painted below it. */
const Blur = z.strictObject({ type: z.literal('blur'), radius: num(0, 100) });

export const BackgroundLayer = z.discriminatedUnion('type', [
  Solid,
  Linear,
  Radial,
  Conic,
  Mesh,
  Noise,
  Shape,
  ImageLayer,
  Blur,
]);
export type BackgroundLayer = z.infer<typeof BackgroundLayer>;

/** Layers are positioned and sized in viewBox units. */
export const BackgroundSpec = z.strictObject({
  version: z.literal(BACKGROUND_VERSION),
  viewBox: z.tuple([coord, coord, viewSize, viewSize]),
  layers: z.array(BackgroundLayer).min(1).max(16),
  animation: z.strictObject({
    type: z.enum(['none', 'drift', 'rotate', 'hue', 'wave', 'pulse']),
    speed: num(0.1, 10),
    loop: z.boolean(),
    durationMs: z.number().int().min(500).max(60000),
  }),
});
export type BackgroundSpec = z.infer<typeof BackgroundSpec>;

/** `steps[v]` upgrades version `v` to `v + 1`. Empty until a second version exists. */
const steps: Record<number, UpgradeStep> = {};

export function migrateBackground(input: unknown): MigrateResult<BackgroundSpec> {
  const upgraded = upgrade(input, BACKGROUND_VERSION, steps);
  if (!upgraded.ok) return upgraded;
  return parseWith(BackgroundSpec, upgraded.value);
}
