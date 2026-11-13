import type { RenderEnv } from '@cropa/core';

import { CAPTURE_REF } from './scene-edits.ts';

export function createContext(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(width, height).getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return ctx;
}

/** What the renderer needs to draw a scene of `bitmap`; the preview and export share it. */
export function renderEnv(bitmap: ImageBitmap): RenderEnv {
  return {
    screenshot: bitmap,
    image: (ref) => (ref === CAPTURE_REF ? bitmap : undefined),
    createContext,
  };
}
