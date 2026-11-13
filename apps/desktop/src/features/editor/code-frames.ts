import {
  extractPalette,
  frameGeometry,
  type CodeLayer,
  type FrameGeometry,
  type PaletteColour,
  type RenderEnv,
  type Scene,
} from '@cropa/core';

import { createSandboxFrameSource } from '../code-sandbox/index.ts';

/** What a code layer needs to know about the canvas and the frame on it. */
export interface CodeScene extends FrameGeometry {
  palette: string[];
}

export interface CodeFrames {
  back: ImageBitmap | null;
  front: ImageBitmap | null;
}

/** What the preview and export need to turn a code layer into bitmaps. The sandbox implements it. */
export interface CodeFrameSource {
  load(source: string): Promise<void>;
  renderFrame(t: number, scene: CodeScene): Promise<CodeFrames>;
  dispose(): void;
}

/** The scene's code layer; a background holds at most one. */
export function codeLayerOf(scene: Scene): CodeLayer | undefined {
  for (const layer of scene.background.layers) {
    if (layer.type === 'code') return layer;
  }
  return undefined;
}

/**
 * A new source of code frames for `sourceText`: the sandbox, or in development builds the
 * stub when the source is the stub's marker. A release build never loads the stub.
 */
export async function createCodeFrameSource(sourceText: string): Promise<CodeFrameSource | null> {
  if (import.meta.env.DEV) {
    const stub = await import('./dev-code-stub.ts');
    if (stub.isDevCodeStubSource(sourceText)) return stub.createDevCodeStub();
  }
  return createSandboxFrameSource();
}

const PALETTE_SIDE = 256;
const palettes = new WeakMap<ImageBitmap, PaletteColour[]>();

/**
 * The dominant colours of the screenshot, heaviest first, found once per bitmap on a copy of
 * at most 256 px on the long side. Empty when the pixels cannot be read.
 */
export function screenshotPalette(bitmap: ImageBitmap): PaletteColour[] {
  const cached = palettes.get(bitmap);
  if (cached) return cached;
  let palette: PaletteColour[] = [];
  try {
    const scale = Math.min(1, PALETTE_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, width, height);
      palette = extractPalette(ctx.getImageData(0, 0, width, height));
    }
  } catch {
    // A code layer then draws without palette colours.
  }
  palettes.set(bitmap, palette);
  return palette;
}

/** The palette's colours as hex strings, for `CodeScene.palette`. */
export function codePalette(bitmap: ImageBitmap): string[] {
  return screenshotPalette(bitmap).map((colour) => colour.hex);
}

/** `env` with the bitmaps of one rendered frame behind `env.code`. */
export function codeEnv(env: RenderEnv, frames: CodeFrames | null): RenderEnv {
  if (!frames) return env;
  return { ...env, code: (_layer, pass) => frames[pass] ?? undefined };
}

/** Releases the bitmaps of a frame once it is no longer drawn. */
export function closeCodeFrames(frames: CodeFrames | null): void {
  frames?.back?.close();
  frames?.front?.close();
}

/**
 * Renders the code layer of `scene` once, for a canvas of `width` x `height`, with the
 * screenshot's `palette`. The caller closes the result. Null when there is no code layer,
 * no source for it or no code to run.
 */
export async function renderCodeFrames(
  scene: Scene,
  width: number,
  height: number,
  t: number,
  palette: string[],
): Promise<CodeFrames | null> {
  const layer = codeLayerOf(scene);
  if (!layer) return null;
  const source = await createCodeFrameSource(layer.source);
  if (!source) return null;
  try {
    await source.load(layer.source);
    return await source.renderFrame(t, { ...frameGeometry(scene, width, height), palette });
  } finally {
    source.dispose();
  }
}
