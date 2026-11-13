import { BACKGROUND_VERSION, type Preset } from '@cropa/core';

import type { CodeFrames, CodeFrameSource, CodeScene } from './code-frames.ts';

// Development only: stands in for the code sandbox so the code layer can be tried in the
// editor. It ignores the source and draws a rotating gradient behind the frame and a dot
// that travels around the card in front of it. Never imported in a release build.

const MARKER = 'cropa-dev-code-stub';

/** True for the source of `devCodePreset`, which the stub draws instead of running it. */
export function isDevCodeStubSource(source: string): boolean {
  return source.includes(MARKER);
}

function canvasFor(scene: CodeScene): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const canvas = new OffscreenCanvas(Math.max(1, scene.width), Math.max(1, scene.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return { canvas, ctx };
}

function drawBack(scene: CodeScene, t: number): ImageBitmap {
  const { canvas, ctx } = canvasFor(scene);
  const hue = t * 360;
  const gradient = ctx.createLinearGradient(0, 0, scene.width, scene.height);
  gradient.addColorStop(0, `hsl(${hue} 80% 55%)`);
  gradient.addColorStop(0.5, `hsl(${hue + 120} 80% 50%)`);
  gradient.addColorStop(1, `hsl(${hue + 240} 80% 55%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, scene.width, scene.height);
  return canvas.transferToImageBitmap();
}

/** The point `t` of the way around the perimeter of the card. */
function onPerimeter(frame: CodeScene['frame'], t: number): { x: number; y: number } {
  const { x, y, width: w, height: h } = frame;
  let d = (t % 1) * 2 * (w + h);
  if (d < w) return { x: x + d, y };
  d -= w;
  if (d < h) return { x: x + w, y: y + d };
  d -= h;
  if (d < w) return { x: x + w - d, y: y + h };
  return { x, y: y + h - (d - w) };
}

function drawFront(scene: CodeScene, t: number): ImageBitmap {
  const { canvas, ctx } = canvasFor(scene);
  const { x, y } = onPerimeter(scene.frame, t);
  const r = Math.max(4, Math.min(scene.width, scene.height) * 0.03);
  const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.3, 'rgba(255,255,255,0.8)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, r * 3, 0, Math.PI * 2);
  ctx.fill();
  return canvas.transferToImageBitmap();
}

export function createDevCodeStub(): CodeFrameSource {
  return {
    load: () => Promise.resolve(),
    renderFrame: (t, scene): Promise<CodeFrames> =>
      Promise.resolve({ back: drawBack(scene, t), front: drawFront(scene, t) }),
    dispose: () => undefined,
  };
}

/** A preset with a code layer, listed in development builds only. */
export const devCodePreset: Preset = {
  version: 1,
  id: 'dev-code',
  name: { en: 'Code (dev)', vi: 'Mã (dev)' },
  background: {
    version: BACKGROUND_VERSION,
    viewBox: [0, 0, 1000, 1000],
    layers: [
      {
        type: 'linear',
        angle: 135,
        stops: [
          { offset: 0, color: '#0f172a' },
          { offset: 1, color: '#334155' },
        ],
      },
      { type: 'code', source: `// ${MARKER}`, durationMs: 4000 },
    ],
    animation: { type: 'none', speed: 1, loop: true, durationMs: 4000 },
  },
};
