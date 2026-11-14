import { useEffect, useState } from 'react';

/** The size of the stand-in screenshot; the renderer scales it to the card. */
const SIZE = { width: 4, height: 3 };
const FALLBACK = '#e6e6e6';
const DARK = '(prefers-color-scheme: dark)';

async function makeBitmap(): Promise<ImageBitmap> {
  const colour = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || FALLBACK;
  const ctx = new OffscreenCanvas(SIZE.width, SIZE.height).getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, SIZE.width, SIZE.height);
  return createImageBitmap(ctx.canvas);
}

/**
 * A small bitmap in the card colour, drawn by the renderer in place of a
 * screenshot before there is one. It is made again when the theme changes.
 */
export function useEmptyBitmap(): ImageBitmap | undefined {
  const [bitmap, setBitmap] = useState<ImageBitmap>();

  useEffect(() => {
    let alive = true;
    let current: ImageBitmap | undefined;
    const make = () => {
      makeBitmap().then(
        (next) => {
          if (!alive) {
            next.close();
            return;
          }
          // The old bitmap is only 12 pixels and the preview may still draw it, so it is left to the collector.
          current = next;
          setBitmap(next);
        },
        () => { console.error('The empty canvas could not be drawn'); },
      );
    };
    const query = window.matchMedia(DARK);
    make();
    query.addEventListener('change', make);
    return () => {
      alive = false;
      query.removeEventListener('change', make);
      current?.close();
    };
  }, []);

  return bitmap;
}
