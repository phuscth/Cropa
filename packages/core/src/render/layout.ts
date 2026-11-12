import type { Scene } from '../schema/scene.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Boxes in scene units (pixels of the original screenshot), origin at the top-left of the frame. */
export interface Layout {
  /** The whole frame, padding included. */
  w: number;
  h: number;
  /** Card plus border. */
  outer: Box;
  /** Screenshot plus inset. */
  card: Box;
  /** The screenshot itself. */
  shot: Box;
}

export function computeLayout(scene: Scene): Layout {
  const { screenshot, frame, output } = scene;
  const bw = frame.border?.width ?? 0;
  const cardW = screenshot.width + 2 * frame.inset;
  const cardH = screenshot.height + 2 * frame.inset;
  const outerW = cardW + 2 * bw;
  const outerH = cardH + 2 * bw;

  let w = outerW + 2 * frame.padding;
  let h = outerH + 2 * frame.padding;
  if (output.aspectRatio) {
    // Grow the shorter side, never shrink.
    const target = output.aspectRatio[0] / output.aspectRatio[1];
    if (w / h < target) w = h * target;
    else h = w / target;
  }

  const outer = { x: (w - outerW) / 2, y: (h - outerH) / 2, w: outerW, h: outerH };
  const card = { x: outer.x + bw, y: outer.y + bw, w: cardW, h: cardH };
  const shot = {
    x: card.x + frame.inset,
    y: card.y + frame.inset,
    w: screenshot.width,
    h: screenshot.height,
  };
  return { w, h, outer, card, shot };
}

/**
 * Pixel size of the exported image. A fixed `output.width` wins over the natural
 * size and keeps the aspect; `scale` multiplies the result (for example 2 for a 2x export).
 */
export function outputSize(scene: Scene, scale = 1): { width: number; height: number } {
  const layout = computeLayout(scene);
  let width = Math.round(layout.w);
  let height = Math.round(layout.h);
  if (scene.output.width !== null) {
    width = scene.output.width;
    height = Math.round((width * layout.h) / layout.w);
  }
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
