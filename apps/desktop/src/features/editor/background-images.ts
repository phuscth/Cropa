import { isBuiltinImage, type BackgroundSpec } from '@cropa/core';

import { commands } from '../../lib/bindings.ts';
import { dataUrlToBitmap } from './load-image.ts';
import { backgroundImageRefs } from './scene-edits.ts';

/** The built-in images' files, by path. Vite turns each into the URL it serves it from. */
const BUILTIN_URLS = import.meta.glob<string>('../../assets/backgrounds/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** The name of every image file shipped in `assets/backgrounds`. */
export function builtinAssetNames(): string[] {
  return Object.keys(BUILTIN_URLS).map((path) => /([^/]+)\.webp$/.exec(path)?.[1] ?? path);
}

/** The URL a built-in image is served from, for an <img>. */
export function builtinUrl(name: string): string | undefined {
  return Object.entries(BUILTIN_URLS).find(([path]) => path.endsWith(`/${name}.webp`))?.[1];
}

/**
 * Decoded images by ref, for the life of the window. The renderer asks for an image
 * synchronously, so every image is loaded here before a scene that draws it is shown.
 * A deleted user image stays, so undo and an export of the scene still draw it.
 */
const bitmaps = new Map<string, ImageBitmap>();
const loading = new Map<string, Promise<boolean>>();

/** The decoded image for `ref`, or undefined when it has not been loaded. */
export function imageBitmap(ref: string): ImageBitmap | undefined {
  return bitmaps.get(ref);
}

/** Keeps an image that is already decoded, such as one the user just added. */
export function cacheImage(ref: string, bitmap: ImageBitmap): void {
  bitmaps.set(ref, bitmap);
}

/**
 * The data URL or asset URL of the image `ref` names, or undefined when it is not
 * there. Rejects when the command itself fails.
 */
async function sourceUrl(ref: string): Promise<string | undefined> {
  const [scheme, name = ''] = ref.split(':');
  if (scheme === 'builtin') return isBuiltinImage(name) ? builtinUrl(name) : undefined;
  if (scheme === 'user') {
    const result = await commands.readBackgroundImage(name);
    return result.status === 'ok' ? result.data : undefined;
  }
  return undefined;
}

async function fetchBitmap(ref: string): Promise<ImageBitmap | undefined> {
  const url = await sourceUrl(ref);
  return url === undefined ? undefined : dataUrlToBitmap(url);
}

/** Loads `ref` into the cache; false when it cannot be found or decoded. */
function load(ref: string): Promise<boolean> {
  if (bitmaps.has(ref)) return Promise.resolve(true);
  let job = loading.get(ref);
  if (!job) {
    job = fetchBitmap(ref)
      .then((bitmap) => {
        if (!bitmap) return false;
        bitmaps.set(ref, bitmap);
        return true;
      })
      // A decode or IPC failure is a missing image; a later request tries again.
      .catch(() => false)
      .finally(() => { loading.delete(ref); });
    loading.set(ref, job);
  }
  return job;
}

/** Loads each of `refs`; the ones that could not be resolved come back in `missing`. */
export async function ensureRefs(refs: readonly string[]): Promise<{ missing: string[] }> {
  const found = await Promise.all(refs.map(load));
  return { missing: refs.filter((_, i) => !found[i]) };
}

/**
 * Loads every image the background draws (the screenshot is always there). Call it
 * before a background goes into the scene, and use `missing` to substitute what is gone.
 */
export function ensureImages(spec: BackgroundSpec): Promise<{ missing: string[] }> {
  return ensureRefs(backgroundImageRefs(spec));
}

const TILE = { width: 128, height: 96 } as const;
const tiles = new Map<string, Promise<string>>();

/** A small picture of a user image for its tile, as a blob URL. Undefined when it can't be loaded. */
export function imageTile(ref: string): Promise<string | undefined> {
  let tile = tiles.get(ref);
  if (!tile) {
    tile = draw(ref);
    tile.catch(() => { tiles.delete(ref); });
    tiles.set(ref, tile);
  }
  return tile.catch(() => undefined);
}

/**
 * Draws the tile. An image that is already loaded is drawn from the cache; any other
 * is decoded at tile size and dropped, so browsing the list never keeps full-size
 * pictures in memory. Only images that go into a scene stay in the cache.
 */
async function draw(ref: string): Promise<string> {
  const canvas = new OffscreenCanvas(TILE.width, TILE.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  const cached = bitmaps.get(ref);
  let bitmap = cached;
  if (!bitmap) {
    const url = await sourceUrl(ref);
    if (url === undefined) throw new Error('image not available');
    const img = new Image();
    img.src = url;
    await img.decode();
    // Scale to fill the tile, like `object-fit: cover`; the overflow is cropped when drawn.
    const scale = Math.min(1, Math.max(TILE.width / img.naturalWidth, TILE.height / img.naturalHeight));
    bitmap = await createImageBitmap(img, {
      resizeWidth: Math.max(1, Math.round(img.naturalWidth * scale)),
      resizeHeight: Math.max(1, Math.round(img.naturalHeight * scale)),
      resizeQuality: 'medium',
    });
  }
  try {
    const fill = Math.max(TILE.width / bitmap.width, TILE.height / bitmap.height);
    const width = bitmap.width * fill;
    const height = bitmap.height * fill;
    ctx.drawImage(bitmap, (TILE.width - width) / 2, (TILE.height - height) / 2, width, height);
  } finally {
    if (!cached) bitmap.close();
  }
  return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
}

let latestChange = 0;

/**
 * Starts a change of the scene's background that waits for something (an image
 * loading). The newest change wins: the returned function is false once another
 * change began, so a slow older one can do nothing.
 */
export function beginBackgroundChange(): () => boolean {
  const mine = ++latestChange;
  return () => mine === latestChange;
}
