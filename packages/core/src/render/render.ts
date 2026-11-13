import type { Scene } from '../schema/scene.ts';
import { renderBackground } from './background.ts';
import type { Canvas2D, CanvasImage, RenderEnv } from './canvas.ts';
import { drawAnnotations } from './annotations.ts';
import { edgeColor } from './edge-color.ts';
import type { Placement } from './layout.ts';
import { frameBoxes, placeFrame } from './layout.ts';
import { redactScreenshot } from './redact.ts';
import { roundedRect } from './shapes.ts';

/**
 * Draws `scene` over the whole of `ctx.canvas`. The order is: the background (a
 * code layer's `back` bitmap sits at its place in the layer stack), the frame, the
 * screenshot with its blur and pixelate annotations baked in, the `front` bitmap of
 * each code layer over the whole canvas, then the other annotations in array order
 * (they may extend over the padding). The frame is scaled uniformly to fit the canvas
 * and centred; the background always covers all of it. A preview passes any canvas,
 * an export passes one sized by `outputSize`.
 *
 * `t` is the animation time in [0, 1); a still image uses 0. A code layer draws what
 * `env.code` returns for it; without that, or without a bitmap, it draws nothing. The
 * background animation and the mask are not drawn yet. The scene is not validated: pass
 * the output of `migrateScene`. Throws a RangeError when `t` is outside [0, 1).
 */
export function render(scene: Scene, t: number, ctx: Canvas2D, env: RenderEnv): void {
  if (!(t >= 0 && t < 1)) {
    throw new RangeError(`render: t (${t}) must be in [0, 1)`);
  }
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const placement = placeFrame(scene, cw, ch);

  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.shadowColor = 'rgba(0,0,0,0)';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, cw, ch);

    renderBackground(scene.background, ctx, env, cw, ch, t);
    drawFrame(scene, placement, redactScreenshot(scene, env) ?? env.screenshot, ctx, env);
    drawCodeFronts(scene, t, ctx, env, cw, ch);
    drawAnnotations(scene, placement.shot, ctx);
  } finally {
    ctx.restore();
  }
}

function drawCodeFronts(
  scene: Scene,
  t: number,
  ctx: Canvas2D,
  env: RenderEnv,
  cw: number,
  ch: number,
): void {
  if (!env.code) return;
  for (const layer of scene.background.layers) {
    if (layer.type !== 'code') continue;
    const img = env.code(layer, 'front', t);
    if (img) ctx.drawImage(img, 0, 0, cw, ch);
  }
}

function drawFrame(
  scene: Scene,
  placement: Placement,
  source: CanvasImage,
  ctx: Canvas2D,
  env: RenderEnv,
): void {
  const { frame } = scene;
  const { s, shot } = placement;
  const { card, outer, radius, border: bw } = frameBoxes(placement, frame);

  // Canvas shadows ignore the transform, so blur and offsets are scaled here.
  // The shadow's source shape is drawn far to the left of the canvas and the
  // offset brings only its shadow back, so no opaque source pixel sits under the
  // card's antialiased edge.
  for (const shadow of frame.shadows) {
    const blur = shadow.blur * s;
    const offsetX = shadow.x * s;
    const away = Math.ceil(outer.x + outer.w + 3 * blur + Math.abs(offsetX)) + 1;
    ctx.save();
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = offsetX + away;
    ctx.shadowOffsetY = shadow.y * s;
    ctx.fillStyle = '#000000';
    roundedRect(ctx, outer.x - away, outer.y, outer.w, outer.h, radius + bw);
    ctx.fill();
    ctx.restore();
  }

  if (frame.border) {
    ctx.fillStyle = frame.border.color;
    roundedRect(ctx, outer.x, outer.y, outer.w, outer.h, radius + bw);
    ctx.fill();
  }

  ctx.save();
  roundedRect(ctx, card.x, card.y, card.w, card.h, radius);
  ctx.clip();
  if (frame.inset > 0) {
    ctx.fillStyle =
      frame.insetColor === 'auto'
        ? (edgeColor(source,(w, h) => env.createContext(w, h)) ?? '#ffffff')
        : frame.insetColor;
    ctx.fillRect(card.x, card.y, card.w, card.h);
  }
  ctx.drawImage(source, shot.x, shot.y, shot.w, shot.h);
  ctx.restore();
}
