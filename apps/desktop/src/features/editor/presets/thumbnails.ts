import { defaultScene, render, type BackgroundSpec, type Scene } from '@cropa/core';

import { ensureImages } from '../background-images.ts';
import { renderEnv } from '../render-env.ts';
import { withoutMissingImages } from '../scene-edits.ts';

const SOURCE = { width: 160, height: 100 } as const;
const THUMB = { width: 128, height: 96 } as const;

let placeholder: ImageBitmap | undefined;

/** A neutral stand-in for a screenshot: white with three grey bars like lines of text. */
function placeholderShot(): ImageBitmap {
  if (placeholder) return placeholder;
  const canvas = new OffscreenCanvas(SOURCE.width, SOURCE.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SOURCE.width, SOURCE.height);
  ctx.fillStyle = '#e4e4e7';
  for (const [y, w] of [[18, 110], [44, 130], [70, 80]] as const) {
    ctx.beginPath();
    ctx.roundRect(15, y, w, 12, 6);
    ctx.fill();
  }
  placeholder = canvas.transferToImageBitmap();
  return placeholder;
}

export function thumbnailScene(background: BackgroundSpec): Scene {
  const scene = defaultScene(SOURCE);
  return {
    ...scene,
    background,
    frame: { ...scene.frame, padding: 28, radius: 8 },
    output: { aspectRatio: [4, 3], width: null },
  };
}

const cache = new Map<string, Promise<string>>();

async function renderThumbnail(background: BackgroundSpec): Promise<string> {
  // An image that is gone shows as the plain colour the editor would fall back to.
  const { missing } = await ensureImages(background);
  const shown = withoutMissingImages(background, missing);
  const canvas = new OffscreenCanvas(THUMB.width, THUMB.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  render(thumbnailScene(shown), 0, ctx, renderEnv(placeholderShot()));
  return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
}

/** A small preview of a background, rendered once per editor session. */
export function presetThumbnail(background: BackgroundSpec): Promise<string> {
  const key = JSON.stringify(background);
  let entry = cache.get(key);
  if (!entry) {
    entry = renderThumbnail(background);
    // A failed render is dropped so a later request can try again.
    entry.catch(() => { cache.delete(key); });
    cache.set(key, entry);
  }
  return entry;
}
