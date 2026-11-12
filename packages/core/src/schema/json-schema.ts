import { z } from 'zod';

import { Annotation } from './annotation.ts';
import { BackgroundSpec } from './background.ts';
import { Scene } from './scene.ts';

/** JSON Schema (draft 2020-12), for AI structured output and for files edited by hand. */
export function sceneJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Scene);
}

export function backgroundJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(BackgroundSpec);
}

export function annotationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Annotation);
}
