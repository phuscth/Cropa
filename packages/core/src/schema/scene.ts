import { z } from 'zod';

import { Annotation, migrateAnnotation } from './annotation.ts';
import { BackgroundSpec, migrateBackground } from './background.ts';
import { Hex, Ref } from './color.ts';
import { outputSize } from '../render/layout.ts';
import { parseWith, prefixIssue, upgrade } from './migrate.ts';
import type { MigrateResult, UpgradeStep } from './migrate.ts';

export const SCENE_VERSION = 1;

/** Longest side of an exported image that a browser canvas can still draw. */
const MAX_OUTPUT_SIDE = 16384;

const num = (min: number, max: number) => z.number().min(min).max(max);

const Shadow = z.strictObject({
  x: num(-2048, 2048),
  y: num(-2048, 2048),
  blur: num(0, 2048),
  color: Hex,
});

/** All lengths are pixels of the original screenshot, so they scale with the export. */
export const Scene = z.strictObject({
  version: z.literal(SCENE_VERSION),
  screenshot: z.strictObject({
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
    mask: z.strictObject({ ref: Ref }).nullable(),
  }),
  frame: z.strictObject({
    padding: num(0, 8192),
    radius: num(0, 4096),
    inset: num(0, 4096),
    /** `'auto'` takes the colour found at the screenshot's edges. */
    insetColor: z.union([z.literal('auto'), Hex]),
    border: z.strictObject({ width: num(0.5, 512), color: Hex }).nullable(),
    /** Drawn in order. */
    shadows: z.array(Shadow).max(4),
  }),
  background: BackgroundSpec,
  annotations: z.array(Annotation).max(500),
  output: z.strictObject({
    aspectRatio: z.tuple([num(0.01, 100), num(0.01, 100)]).nullable(),
    width: z.number().int().min(16).max(16384).nullable(),
  }),
});
export type Scene = z.infer<typeof Scene>;

/** `steps[v]` upgrades version `v` to `v + 1`. Empty until a second version exists. */
const steps: Record<number, UpgradeStep> = {};

export function migrateScene(input: unknown): MigrateResult<Scene> {
  const upgraded = upgrade(input, SCENE_VERSION, steps);
  if (!upgraded.ok) return upgraded;
  const doc = { ...upgraded.value };
  const issues: string[] = [];

  // Nested documents carry their own version, so they migrate on their own first.
  if ('background' in doc) {
    const nested = migrateBackground(doc.background);
    if (nested.ok) doc.background = nested.value;
    else if (nested.error.kind === 'too-new') return nested;
    else issues.push(...nested.error.issues.map((i) => prefixIssue('background', i)));
  }
  if (Array.isArray(doc.annotations)) {
    const list: unknown[] = [];
    for (const [i, item] of (doc.annotations as unknown[]).entries()) {
      const nested = migrateAnnotation(item);
      if (nested.ok) list.push(nested.value);
      else if (nested.error.kind === 'too-new') return nested;
      else issues.push(...nested.error.issues.map((m) => prefixIssue(`annotations.${i}`, m)));
    }
    doc.annotations = list;
  }
  if (issues.length > 0) return { ok: false, error: { kind: 'invalid', issues } };

  const parsed = parseWith(Scene, doc);
  if (!parsed.ok) return parsed;
  const size = outputSize(parsed.value, 1);
  if (Math.max(size.width, size.height) > MAX_OUTPUT_SIDE) {
    return {
      ok: false,
      error: {
        kind: 'invalid',
        issues: [
          `output: the image would be ${size.width}x${size.height} pixels, over the ${MAX_OUTPUT_SIDE} limit; reduce the padding or the aspect ratio`,
        ],
      },
    };
  }
  return parsed;
}

/** A valid scene for a screenshot of this size: soft shadow, rounded corners, gradient background. */
export function defaultScene({ width, height }: { width: number; height: number }): Scene {
  const m = Math.max(width, height);
  return {
    version: SCENE_VERSION,
    screenshot: { width, height, mask: null },
    frame: {
      // Keeps the frame within the output limit for the largest screenshots.
      padding: Math.max(0, Math.min(Math.max(16, Math.round(m * 0.06)), Math.floor((MAX_OUTPUT_SIDE - m) / 2))),
      radius: Math.max(4, Math.round(m * 0.01)),
      inset: 0,
      insetColor: 'auto',
      border: null,
      shadows: [
        {
          x: 0,
          y: Math.round(m * 0.01),
          blur: Math.min(2048, Math.round(m * 0.03)),
          color: '#00000040',
        },
        {
          x: 0,
          y: Math.round(m * 0.002),
          blur: Math.min(2048, Math.round(m * 0.006)),
          color: '#0000001f',
        },
      ],
    },
    background: {
      version: 1,
      viewBox: [0, 0, 1000, 1000],
      layers: [
        {
          type: 'linear',
          angle: 135,
          stops: [
            { offset: 0, color: '#6366f1' },
            { offset: 1, color: '#ec4899' },
          ],
        },
      ],
      animation: { type: 'none', speed: 1, loop: true, durationMs: 4000 },
    },
    annotations: [],
    output: { aspectRatio: null, width: null },
  };
}
