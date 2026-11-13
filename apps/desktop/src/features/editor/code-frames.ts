import {
  frameGeometry,
  type CodeLayer,
  type FrameGeometry,
  type RenderEnv,
  type Scene,
} from '@cropa/core';

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
 * A new source of code frames, or null when this build has none, in which case a code
 * layer draws nothing and the layers below it show.
 */
export async function createCodeFrameSource(): Promise<CodeFrameSource | null> {
  if (import.meta.env.DEV) {
    const { createDevCodeStub } = await import('./dev-code-stub.ts');
    return createDevCodeStub();
  }
  return null;
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
 * Renders the code layer of `scene` once, for a canvas of `width` x `height`. The caller
 * closes the result. Null when there is no code layer, no source for it or no code to run.
 */
export async function renderCodeFrames(
  scene: Scene,
  width: number,
  height: number,
  t: number,
): Promise<CodeFrames | null> {
  const layer = codeLayerOf(scene);
  if (!layer) return null;
  const source = await createCodeFrameSource();
  if (!source) return null;
  try {
    await source.load(layer.source);
    // The palette stays empty until it is read from the screenshot.
    return await source.renderFrame(t, { ...frameGeometry(scene, width, height), palette: [] });
  } finally {
    source.dispose();
  }
}
