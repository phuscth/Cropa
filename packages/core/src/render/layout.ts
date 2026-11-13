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

/** Where the frame lands on a canvas of a given size. */
export interface Placement {
  layout: Layout;
  /** Uniform scale from scene units to canvas pixels. */
  s: number;
  /** Offset of the frame's top-left corner on the canvas. */
  ox: number;
  oy: number;
  /** The screenshot in whole canvas pixels. */
  shot: Box;
}

/**
 * Scales the frame uniformly to fit a `cw` x `ch` canvas and centres it. The
 * screenshot is rounded to whole canvas pixels, so a 1x export with integer
 * padding copies the pixels exactly.
 */
export function placeFrame(scene: Scene, cw: number, ch: number): Placement {
  const layout = computeLayout(scene);
  const s = Math.min(cw / layout.w, ch / layout.h);
  const ox = (cw - layout.w * s) / 2;
  const oy = (ch - layout.h * s) / 2;
  const shot = {
    x: Math.round(ox + layout.shot.x * s),
    y: Math.round(oy + layout.shot.y * s),
    w: Math.max(1, Math.round(layout.shot.w * s)),
    h: Math.max(1, Math.round(layout.shot.h * s)),
  };
  return { layout, s, ox, oy, shot };
}

/**
 * The screenshot's rectangle on a `canvasWidth` x `canvasHeight` canvas, in canvas
 * pixels, exactly as `render` draws it. An image point (ix, iy) lands at
 * `x + ix * w / screenshot.width`, `y + iy * h / screenshot.height`.
 */
export function screenshotRect(scene: Scene, canvasWidth: number, canvasHeight: number): Box {
  return placeFrame(scene, canvasWidth, canvasHeight).shot;
}

/** The frame's boxes on the canvas, in canvas pixels, as `render` draws them. */
export interface FrameBoxes {
  /** Card plus border; the border's outer edge. */
  outer: Box;
  /** Screenshot plus inset. */
  card: Box;
  /** Corner radius of the card. The outer corner radius is `radius + border`. */
  radius: number;
  /** Border width, drawn outside the card. 0 without a border. */
  border: number;
}

/** The card, border and corner radius for a placement; the renderer and `frameGeometry` share it. */
export function frameBoxes(placement: Placement, frame: Scene['frame']): FrameBoxes {
  const { s, shot } = placement;
  const border = (frame.border?.width ?? 0) * s;
  const inset = frame.inset * s;
  // The card and border are built around the rounded screenshot rectangle.
  const card = {
    x: shot.x - inset,
    y: shot.y - inset,
    w: shot.w + 2 * inset,
    h: shot.h + 2 * inset,
  };
  const outer = { x: card.x - border, y: card.y - border, w: card.w + 2 * border, h: card.h + 2 * border };
  return { outer, card, radius: frame.radius * s, border };
}

/** The canvas and the frame on it, for code that draws around the frame. */
export interface FrameGeometry {
  /** Canvas size in pixels. */
  width: number;
  height: number;
  /**
   * The card (screenshot plus inset) in canvas pixels, exactly as `render` draws it.
   * `radius` is the card's corner radius; `border` is the border width, drawn outside
   * this rectangle, so the outer corner radius is `radius + border`.
   */
  frame: { x: number; y: number; width: number; height: number; radius: number; border: number };
}

export function frameGeometry(scene: Scene, canvasWidth: number, canvasHeight: number): FrameGeometry {
  const { card, radius, border } = frameBoxes(placeFrame(scene, canvasWidth, canvasHeight), scene.frame);
  return {
    width: canvasWidth,
    height: canvasHeight,
    frame: { x: card.x, y: card.y, width: card.w, height: card.h, radius, border },
  };
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
