import { screenshotRect, type Scene } from '@cropa/core';

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The preview canvas: its CSS size and the size of its backing store in device pixels. */
export interface PreviewGeometry {
  css: Size;
  backing: Size;
}

/** The screenshot's rectangle in CSS px of the preview canvas. */
export function shotRectCss(
  scene: Scene,
  g: PreviewGeometry,
): { x: number; y: number; w: number; h: number } {
  const r = screenshotRect(scene, g.backing.width, g.backing.height);
  const sx = g.css.width / g.backing.width;
  const sy = g.css.height / g.backing.height;
  return { x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy };
}

/** A point in CSS px relative to the canvas, as image pixels. */
export function toImage(scene: Scene, g: PreviewGeometry, p: Point): Point {
  const r = shotRectCss(scene, g);
  return {
    x: ((p.x - r.x) * scene.screenshot.width) / r.w,
    y: ((p.y - r.y) * scene.screenshot.height) / r.h,
  };
}

/** A point in image pixels, as CSS px relative to the canvas. */
export function toCss(scene: Scene, g: PreviewGeometry, p: Point): Point {
  const r = shotRectCss(scene, g);
  return {
    x: r.x + (p.x * r.w) / scene.screenshot.width,
    y: r.y + (p.y * r.h) / scene.screenshot.height,
  };
}

/** Image pixels per CSS pixel, to turn on-screen tolerances into image units. */
export function imagePerCss(scene: Scene, g: PreviewGeometry): number {
  return scene.screenshot.width / shotRectCss(scene, g).w;
}
