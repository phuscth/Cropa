import {
  defaultScene,
  render,
  withoutCodeLayers,
  type BackgroundSpec,
  type RenderEnv,
  type Scene,
} from '@cropa/core';

import { ensureImages, loadSmallImage } from '../background-images.ts';
import { closeCodeFrames, codeEnv, renderCodeFrames } from '../code-frames.ts';
import { renderEnv } from '../render-env.ts';
import { isAiPreset } from './preset-file.ts';
import { withoutMissingImages } from '../scene-edits.ts';

const SOURCE = { width: 160, height: 100 } as const;
const THUMB = { width: 128, height: 96 } as const;
/** Preset cards are about 196px wide, so their previews are drawn larger. */
const PRESET_THUMB = { width: 336, height: 252 } as const;

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

async function drawThumbnail(background: BackgroundSpec, env: RenderEnv): Promise<string> {
  const canvas = new OffscreenCanvas(PRESET_THUMB.width, PRESET_THUMB.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  render(thumbnailScene(background), 0, ctx, env);
  return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
}

// Each code thumbnail starts a sandbox, so they are drawn one after the other.
let codeQueue: Promise<unknown> = Promise.resolve();

function inCodeQueue<T>(job: () => Promise<T>): Promise<T> {
  const next = codeQueue.then(job, job);
  codeQueue = next.catch(() => undefined);
  return next;
}

/** The first frame of a background with a code layer, drawn by the sandbox; null when it can't be. */
async function renderCodeThumbnail(background: BackgroundSpec): Promise<string | null> {
  let frames: Awaited<ReturnType<typeof renderCodeFrames>> = null;
  try {
    frames = await renderCodeFrames(thumbnailScene(background), PRESET_THUMB.width, PRESET_THUMB.height, 0, []);
    if (!frames) return null;
    return await drawThumbnail(background, codeEnv(renderEnv(placeholderShot()), frames));
  } catch {
    // No WebGL, a timeout or a sandbox failure: the caller draws the layers under the code.
    return null;
  } finally {
    closeCodeFrames(frames);
  }
}

async function renderThumbnail(background: BackgroundSpec): Promise<string> {
  // An image that is gone shows as the plain colour the editor would fall back to.
  const { missing } = await ensureImages(background);
  const shown = withoutMissingImages(background, missing);
  if (shown.layers.some((layer) => layer.type === 'code')) {
    const drawn = await inCodeQueue(() => renderCodeThumbnail(shown));
    if (drawn !== null) return drawn;
    const plain = withoutCodeLayers(shown);
    // Nothing but code: the tile stays a neutral box.
    if (!plain) throw new Error('the background is only code and could not be drawn');
    return drawThumbnail(plain, renderEnv(placeholderShot()));
  }
  return drawThumbnail(shown, renderEnv(placeholderShot()));
}

/** A small preview of a background, rendered once per editor session. */
export function presetThumbnail(background: BackgroundSpec): Promise<string> {
  const key = JSON.stringify(background);
  let entry = cache.get(key);
  if (!entry) {
    entry = renderThumbnail(background);
    // A failed render is dropped so a later request can try again, except for code: its sandbox
    // failed once and would start again on every reload, so the tile stays a neutral box.
    entry.catch(() => { if (!isAiPreset(background)) cache.delete(key); });
    cache.set(key, entry);
  }
  return entry;
}

const imageCache = new Map<string, Promise<string>>();

async function renderImageThumbnail(ref: string): Promise<string> {
  const { bitmap, release } = await loadSmallImage(ref, THUMB);
  try {
    const canvas = new OffscreenCanvas(THUMB.width, THUMB.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    const background: BackgroundSpec = {
      ...defaultScene(SOURCE).background,
      layers: [{ type: 'image', ref, fit: 'cover' }],
    };
    // Only this image is offered, so the full-size picture never has to be loaded.
    const env = { ...renderEnv(placeholderShot()), image: (r: string) => (r === ref ? bitmap : undefined) };
    render(thumbnailScene(background), 0, ctx, env);
    return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
  } finally {
    release();
  }
}

/** A small preview of one image like the preset tiles, as a blob URL; undefined when it can't be loaded. */
export function imageThumbnail(ref: string): Promise<string | undefined> {
  let entry = imageCache.get(ref);
  if (!entry) {
    entry = renderImageThumbnail(ref);
    entry.catch(() => { imageCache.delete(ref); });
    imageCache.set(ref, entry);
  }
  return entry.catch(() => undefined);
}
