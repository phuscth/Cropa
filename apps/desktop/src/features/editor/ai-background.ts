import {
  BACKGROUND_EXAMPLES,
  judgeModuleCheck,
  type BackgroundInput,
  type Validation,
} from '@cropa/ai';
import {
  frameGeometry,
  outputSize,
  type BackgroundSpec,
  type FrameGeometry,
  type PaletteColour,
  type Scene,
} from '@cropa/core';

import type { AiMockScript_Deserialize } from '../../lib/bindings.ts';
import { applyBackground, sameBackground } from './scene-edits.ts';
import {
  checkModule,
  type CheckModuleOptions,
  type CodeScene,
  type ModuleCheck,
} from '../code-sandbox/index.ts';

/** The check renders a loop at this size at most; a 4K export is checked at 1080p. */
const MAX_CHECK_SIDE = 1920;

/** The canvas the AI's module is written and checked for: the output size, never above 1920 px. */
export function checkSize(scene: Scene): { width: number; height: number } {
  const size = outputSize(scene, 1);
  const scale = Math.min(1, MAX_CHECK_SIDE / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** The task input and the scene the module is checked on, from the same numbers. */
export function backgroundRequest(
  scene: Scene,
  description: string,
  palette: readonly PaletteColour[],
): { input: BackgroundInput; check: CodeScene } {
  const { width, height } = checkSize(scene);
  const geometry: FrameGeometry = frameGeometry(scene, width, height);
  return {
    input: { description: description.trim(), palette, frame: geometry },
    check: { ...geometry, palette: palette.map((colour) => colour.hex) },
  };
}

export interface BackgroundValidator {
  validate: (spec: BackgroundSpec, ctx?: { signal?: AbortSignal }) => Promise<Validation>;
  /** True once a check found that this window has no WebGL. */
  noWebgl: () => boolean;
}

/**
 * Checks the code layer of a generated background in the sandbox: it must load, render each
 * frame in time and loop. `check` is injectable for tests.
 */
export function backgroundValidator(
  scene: CodeScene,
  check: (source: string, scene: CodeScene, options?: CheckModuleOptions) => Promise<ModuleCheck> = checkModule,
): BackgroundValidator {
  let missingWebgl = false;
  return {
    async validate(spec, ctx) {
      const layer = spec.layers.find((l) => l.type === 'code');
      if (layer === undefined) return { ok: false, message: 'no code layer' };
      const result = await check(layer.source, scene, ctx?.signal ? { signal: ctx.signal } : {});
      if (result.error?.kind === 'no-webgl') missingWebgl = true;
      return judgeModuleCheck(result);
    },
    noWebgl: () => missingWebgl,
  };
}

/**
 * The background to show while the AI works: the closest preset, unless the scene already has
 * generated code, which then stays until the result arrives (and stays if the run fails).
 */
export function backgroundWhileWaiting(current: BackgroundSpec, fallback: BackgroundSpec): BackgroundSpec {
  return current.layers.some((layer) => layer.type === 'code') ? current : fallback;
}

/**
 * Puts the AI's `result` into `scene` only when its background is still `shown`, the one this
 * run left in place. Any edit made meanwhile (a colour, a blur, an undo) wins and the result is
 * dropped; the scene itself comes back, so no history entry is made.
 */
export function applyGenerated(scene: Scene, shown: BackgroundSpec, result: BackgroundSpec): Scene {
  return sameBackground(scene.background, shown) ? applyBackground(scene, result) : scene;
}

/** What the mock provider answers in development: the first example module after a short wait. */
export function backgroundMockScript(): AiMockScript_Deserialize {
  const example = BACKGROUND_EXAMPLES[0];
  return {
    delayMs: 1500,
    events: [{ kind: 'delta', text: '…' }],
    result: example
      ? { source: example.source, durationMs: example.durationMs, threeD: example.threeD }
      : null,
    error: null,
  };
}

/** The source of the background's code layer, when it has one. */
export function codeSourceOf(background: BackgroundSpec): string | undefined {
  for (const layer of background.layers) {
    if (layer.type === 'code') return layer.source;
  }
  return undefined;
}

/**
 * `current` with its code layer swapped for the one in `result`, so the layers a user loaded
 * with a preset stay as they were. `result` alone when `current` has no code layer.
 */
export function replaceCodeLayer(current: BackgroundSpec, result: BackgroundSpec): BackgroundSpec {
  const next = result.layers.find((layer) => layer.type === 'code');
  if (!next) return current;
  if (!current.layers.some((layer) => layer.type === 'code')) return result;
  return { ...current, layers: current.layers.map((layer) => (layer.type === 'code' ? next : layer)) };
}

/** A preset's name limit, in characters. */
export const PRESET_NAME_MAX = 40;

/** A preset name from the description of an AI background: one line, at most 40 characters. */
export function presetNameFrom(description: string): string {
  return Array.from(description.replace(/\s+/g, ' ').trim()).slice(0, PRESET_NAME_MAX).join('').trim();
}
