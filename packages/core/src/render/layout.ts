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
  /** Scale from scene units to canvas pixels; the smaller axis scale when the two differ by under a pixel. */
  s: number;
  /** Offset of the frame's top-left corner on the canvas. */
  ox: number;
  oy: number;
  /** The screenshot in whole canvas pixels. */
  shot: Box;
}

/**
 * Places the frame on a `cw` x `ch` canvas. Normally it is scaled uniformly to fit and
 * centred. When the canvas is the layout scaled and rounded per side (an export sized by
 * `outputSizeAtLongEdge`, off the layout's aspect by under a pixel), each axis is mapped on its
 * own instead, so the layout's edges land on the canvas edges and no strip of background is
 * left. The screenshot is rounded to whole canvas pixels, so a 1x export with integer padding
 * copies the pixels exactly.
 */
export function placeFrame(scene: Scene, cw: number, ch: number): Placement {
  const layout = computeLayout(scene);
  const sx = cw / layout.w;
  const sy = ch / layout.h;
  const sMax = Math.max(sx, sy);
  const s = Math.min(sx, sy);
  if (Math.abs(cw - layout.w * sMax) < 1 && Math.abs(ch - layout.h * sMax) < 1) {
    const x = Math.round(layout.shot.x * sx);
    const y = Math.round(layout.shot.y * sy);
    const shot = {
      x,
      y,
      w: Math.max(1, Math.round((layout.shot.x + layout.shot.w) * sx) - x),
      h: Math.max(1, Math.round((layout.shot.y + layout.shot.h) * sy) - y),
    };
    return { layout, s, ox: 0, oy: 0, shot };
  }
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

/**
 * Pixel size of an export whose longer side is exactly `longEdge`. The shorter side
 * follows the frame's real aspect ratio (the layout, not the rounded 1x size), rounded once,
 * so float error never turns 2560 into 2559. Ignores `output.width`: a fixed width is the
 * caller's to keep.
 */
export function outputSizeAtLongEdge(
  scene: Scene,
  longEdge: number,
): { width: number; height: number } {
  const layout = computeLayout(scene);
  if (layout.w >= layout.h) {
    return { width: longEdge, height: Math.max(1, Math.round((longEdge * layout.h) / layout.w)) };
  }
  return { width: Math.max(1, Math.round((longEdge * layout.w) / layout.h)), height: longEdge };
}
