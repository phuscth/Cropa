import { render, type Scene } from '@cropa/core';

import type { ExportFormat } from '../../../lib/bindings.ts';
import { ExportEncodeError } from '../../../lib/errors.ts';
import {
  closeCodeFrames,
  codeEnv,
  codePalette,
  renderCodeFrames,
  type CodeFrames,
} from '../code-frames.ts';
import { loadInter } from '../fonts.ts';
import { renderEnv } from '../render-env.ts';
import { exportPlan, type ExportSize } from './plan.ts';

function context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return ctx;
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('The encoded image could not be read'));
    };
    reader.onerror = () => { reject(reader.error ?? new Error('The encoded image could not be read')); };
    reader.readAsDataURL(blob);
  });
}

export interface RenderedImage {
  dataUrl: string;
  /** The scene has a code layer that could not be rendered, so the image lacks it. */
  codeLayerFailed: boolean;
}

/**
 * Renders the scene with the shared renderer and encodes it as a data URL. A code layer that
 * fails to render is left out and reported in `codeLayerFailed`; the rest still exports.
 */
export async function renderImage(
  scene: Scene,
  bitmap: ImageBitmap,
  format: ExportFormat,
  size: ExportSize,
): Promise<RenderedImage> {
  await loadInter();
  const plan = exportPlan(scene, format, size);
  const canvas = new OffscreenCanvas(plan.width, plan.height);
  let frames: CodeFrames | null = null;
  let codeLayerFailed = false;
  try {
    frames = await renderCodeFrames(scene, plan.width, plan.height, 0, codePalette(bitmap));
  } catch {
    // The layers below the code layer still export.
    console.error('The code layer could not be rendered for export');
    codeLayerFailed = true;
  }
  try {
    render(scene, 0, context(canvas), codeEnv(renderEnv(bitmap), frames));
  } finally {
    closeCodeFrames(frames);
  }

  let source = canvas;
  if (format === 'jpeg') {
    // JPEG has no alpha: transparent pixels would turn black, so put the image on white.
    source = new OffscreenCanvas(plan.width, plan.height);
    const ctx = context(source);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, plan.width, plan.height);
    ctx.drawImage(canvas, 0, 0);
  }

  const blob = await source.convertToBlob(
    plan.quality === undefined ? { type: plan.mime } : { type: plan.mime, quality: plan.quality },
  );
  if (blob.type !== plan.mime) throw new ExportEncodeError(format);
  return { dataUrl: await toDataUrl(blob), codeLayerFailed };
}
