import type { BackgroundLayer, BackgroundSpec } from '../schema/background.ts';
import { parseHex } from '../schema/color.ts';
import type { Canvas2D, CanvasGradientLike, CanvasImage, RenderEnv } from './canvas.ts';

const NOISE_TILE = 128;
const DEG = Math.PI / 180;

/** Small seeded PRNG (mulberry32): the same seed always gives the same noise. */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addStops(gradient: CanvasGradientLike, stops: { offset: number; color: string }[]): void {
  for (const stop of stops) gradient.addColorStop(stop.offset, stop.color);
}

/** The same colour with alpha 0, so a fade does not pass through grey. */
function transparent(color: string): string {
  const c = parseHex(color);
  return c ? `rgba(${c.r},${c.g},${c.b},0)` : 'rgba(0,0,0,0)';
}

function withAlpha(color: string): string {
  const c = parseHex(color);
  return c ? `rgba(${c.r},${c.g},${c.b},${c.a})` : color;
}

/**
 * Paints `spec` over the whole canvas `cw` x `ch`. The viewBox maps onto the canvas
 * non-uniformly (like SVG `preserveAspectRatio="none"`); sizes that must stay round
 * (blur radius, noise grain) use the smaller of the two scales. `t` in [0, 1) is passed
 * to a code layer's bitmap lookup.
 */
export function renderBackground(
  spec: BackgroundSpec,
  ctx: Canvas2D,
  env: RenderEnv,
  cw: number,
  ch: number,
  t: number,
): void {
  const [vx, vy, vw, vh] = spec.viewBox;
  const sx = cw / vw;
  const sy = ch / vh;
  const iso = Math.min(sx, sy);

  const viewBoxTransform = () => {
    ctx.setTransform(sx, 0, 0, sy, -vx * sx, -vy * sy);
  };
  const identity = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  for (const layer of spec.layers) {
    ctx.save();
    identity();
    ctx.globalAlpha = 'opacity' in layer ? (layer.opacity ?? 1) : 1;
    paintLayer(layer);
    ctx.restore();
  }

  function paintLayer(layer: BackgroundLayer): void {
    switch (layer.type) {
      case 'solid':
        ctx.fillStyle = layer.color;
        ctx.fillRect(0, 0, cw, ch);
        return;
      case 'linear': {
        // CSS semantics: the gradient line runs through the centre and is long
        // enough that the corners take the first and last stop exactly.
        const a = layer.angle * DEG;
        const dx = Math.sin(a);
        const dy = -Math.cos(a);
        const half = (Math.abs(cw * dx) + Math.abs(ch * dy)) / 2;
        const g = ctx.createLinearGradient(
          cw / 2 - dx * half,
          ch / 2 - dy * half,
          cw / 2 + dx * half,
          ch / 2 + dy * half,
        );
        addStops(g, layer.stops);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, cw, ch);
        return;
      }
      case 'radial': {
        viewBoxTransform();
        const g = ctx.createRadialGradient(layer.cx, layer.cy, 0, layer.cx, layer.cy, layer.r);
        addStops(g, layer.stops);
        ctx.fillStyle = g;
        ctx.fillRect(vx, vy, vw, vh);
        return;
      }
      case 'conic': {
        viewBoxTransform();
        // CSS starts at the top, canvas at the right.
        const g = ctx.createConicGradient((layer.angle - 90) * DEG, layer.cx, layer.cy);
        addStops(g, layer.stops);
        ctx.fillStyle = g;
        ctx.fillRect(vx, vy, vw, vh);
        return;
      }
      case 'mesh':
        viewBoxTransform();
        for (const p of layer.points) {
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
          g.addColorStop(0, withAlpha(p.color));
          g.addColorStop(1, transparent(p.color));
          ctx.fillStyle = g;
          ctx.fillRect(vx, vy, vw, vh);
        }
        return;
      case 'noise': {
        const tile = makeNoiseTile(env, layer.seed);
        // Each tile pixel is one grain. Grains under a device pixel are averaged
        // (smoothing on) so the look matches at any canvas size; the drawn tile
        // is kept at 16 px or more only to bound the number of draws.
        const grainPx = layer.grain * iso;
        const size = Math.max(16, NOISE_TILE * grainPx);
        ctx.imageSmoothingEnabled = grainPx < 1;
        for (let y = 0; y < ch; y += size) {
          for (let x = 0; x < cw; x += size) {
            ctx.drawImage(tile.canvas, x, y, size, size);
          }
        }
        return;
      }
      case 'shape': {
        viewBoxTransform();
        ctx.translate(layer.x + layer.w / 2, layer.y + layer.h / 2);
        ctx.rotate(layer.rotation * DEG);
        ctx.fillStyle = layer.color;
        if (layer.shape === 'rect') {
          ctx.fillRect(-layer.w / 2, -layer.h / 2, layer.w, layer.h);
        } else {
          ctx.beginPath();
          ctx.ellipse(0, 0, layer.w / 2, layer.h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        return;
      }
      case 'image': {
        const img = env.image?.(layer.ref);
        if (img) drawImageFit(ctx, img, layer.fit, cw, ch);
        return;
      }
      case 'code': {
        const img = env.code?.(layer, 'back', t);
        if (img) ctx.drawImage(img, 0, 0, cw, ch);
        return;
      }
      case 'blur':
        blurBelow(ctx, env, cw, ch, layer.radius * iso);
        return;
    }
  }
}

function makeNoiseTile(env: RenderEnv, seed: number): Canvas2D {
  const tile = env.createContext(NOISE_TILE, NOISE_TILE);
  const image = tile.createImageData(NOISE_TILE, NOISE_TILE);
  const random = mulberry32(seed);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = Math.floor(random() * 256);
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  tile.putImageData(image, 0, 0);
  return tile;
}

function drawImageFit(
  ctx: Canvas2D,
  img: CanvasImage,
  fit: 'cover' | 'contain' | 'stretch',
  cw: number,
  ch: number,
): void {
  if (fit === 'stretch') {
    ctx.drawImage(img, 0, 0, cw, ch);
    return;
  }
  const ratio = Math.min(cw / img.width, ch / img.height);
  const cover = Math.max(cw / img.width, ch / img.height);
  const k = fit === 'cover' ? cover : ratio;
  const w = img.width * k;
  const h = img.height * k;
  ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
}

/**
 * Blurs what is painted so far. The canvas is copied into a larger one whose
 * margin repeats the edge pixels, so the blur does not fade to transparent at the
 * canvas edges, then drawn back through the blur filter.
 */
function blurBelow(ctx: Canvas2D, env: RenderEnv, cw: number, ch: number, radius: number): void {
  // Capped relative to the canvas so the padded copy stays a sane size.
  radius = Math.min(radius, 0.1 * Math.max(cw, ch));
  if (radius < 0.5) return;
  const m = Math.ceil(radius * 3);
  const pad = env.createContext(cw + 2 * m, ch + 2 * m);
  pad.imageSmoothingEnabled = false;
  const src = ctx.canvas;

  pad.drawImage(src, 0, 0, cw, ch, m, m, cw, ch);
  // Edge strips and corners, each one source pixel stretched over the margin.
  pad.drawImage(src, 0, 0, 1, ch, 0, m, m, ch);
  pad.drawImage(src, cw - 1, 0, 1, ch, m + cw, m, m, ch);
  pad.drawImage(src, 0, 0, cw, 1, m, 0, cw, m);
  pad.drawImage(src, 0, ch - 1, cw, 1, m, m + ch, cw, m);
  pad.drawImage(src, 0, 0, 1, 1, 0, 0, m, m);
  pad.drawImage(src, cw - 1, 0, 1, 1, m + cw, 0, m, m);
  pad.drawImage(src, 0, ch - 1, 1, 1, 0, m + ch, m, m);
  pad.drawImage(src, cw - 1, ch - 1, 1, 1, m + cw, m + ch, m, m);

  ctx.clearRect(0, 0, cw, ch);
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(pad.canvas, -m, -m, cw + 2 * m, ch + 2 * m);
  ctx.filter = 'none';
}
