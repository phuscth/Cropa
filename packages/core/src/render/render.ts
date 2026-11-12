import type { Scene } from '../schema/scene.ts';
import { renderBackground } from './background.ts';
import type { Canvas2D, RenderEnv } from './canvas.ts';
import { edgeColor } from './edge-color.ts';
import { computeLayout } from './layout.ts';

/** Rounded rectangle path built from `arcTo`; the radius is kept within half the shorter side. */
function roundedRect(
  ctx: Canvas2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draws `scene` over the whole of `ctx.canvas`: the background, then the framed
 * screenshot. The frame is scaled uniformly to fit the canvas and centred; the
 * background always covers all of it. A preview passes any canvas, an export
 * passes one sized by `outputSize`.
 *
 * `t` is the animation time in [0, 1); a still image uses 0. Animation, the
 * mask and annotations are not drawn yet. The scene is not validated: pass the
 * output of `migrateScene`. Throws a RangeError when `t` is outside [0, 1).
 */
export function render(scene: Scene, t: number, ctx: Canvas2D, env: RenderEnv): void {
  if (!(t >= 0 && t < 1)) {
    throw new RangeError(`render: t (${t}) must be in [0, 1)`);
  }
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const layout = computeLayout(scene);
  const s = Math.min(cw / layout.w, ch / layout.h);
  const ox = (cw - layout.w * s) / 2;
  const oy = (ch - layout.h * s) / 2;

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

    renderBackground(scene.background, ctx, env, cw, ch);
    drawFrame(scene, layout, s, ox, oy, ctx, env);
  } finally {
    ctx.restore();
  }
}

function drawFrame(
  scene: Scene,
  layout: ReturnType<typeof computeLayout>,
  s: number,
  ox: number,
  oy: number,
  ctx: Canvas2D,
  env: RenderEnv,
): void {
  const { frame } = scene;
  const bw = (frame.border?.width ?? 0) * s;
  const inset = frame.inset * s;

  // Round the screenshot to whole canvas pixels and build the card and border
  // around it, so a 1x export with integer padding copies the pixels exactly.
  const shot = {
    x: Math.round(ox + layout.shot.x * s),
    y: Math.round(oy + layout.shot.y * s),
    w: Math.max(1, Math.round(layout.shot.w * s)),
    h: Math.max(1, Math.round(layout.shot.h * s)),
  };
  const card = {
    x: shot.x - inset,
    y: shot.y - inset,
    w: shot.w + 2 * inset,
    h: shot.h + 2 * inset,
  };
  const outer = { x: card.x - bw, y: card.y - bw, w: card.w + 2 * bw, h: card.h + 2 * bw };
  const radius = frame.radius * s;

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
        ? (edgeColor(env.screenshot, (w, h) => env.createContext(w, h)) ?? '#ffffff')
        : frame.insetColor;
    ctx.fillRect(card.x, card.y, card.w, card.h);
  }
  ctx.drawImage(env.screenshot, shot.x, shot.y, shot.w, shot.h);
  ctx.restore();
}
