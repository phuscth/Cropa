// Image snapshot tests for the renderer. Expected images live in ./__snapshots__.
// A missing snapshot fails. To (re)write them after a deliberate change, then review the PNGs:
//   PowerShell: $env:UPDATE_SNAPSHOTS=1; pnpm --filter @cropa/core test
//   POSIX:      UPDATE_SNAPSHOTS=1 pnpm --filter @cropa/core test
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import { builtinPresets } from '../presets/builtin.ts';
import { defaultScene } from '../schema/scene.ts';
import type { Scene } from '../schema/scene.ts';
import type { BackgroundLayer } from '../schema/background.ts';
import type { RenderEnv } from './canvas.ts';
import { outputSize } from './layout.ts';
import { render } from './render.ts';

const SNAPSHOT_DIR = join(import.meta.dirname, '__snapshots__');

function makeScreenshot(width = 160, height = 100): Canvas {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f4f5';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ef4444';
  ctx.fillRect(12, 12, 50, 30);
  ctx.fillStyle = '#22c55e';
  ctx.fillRect(80, 20, 60, 20);
  ctx.fillStyle = '#3b82f6';
  ctx.fillRect(20, 58, 40, 28);
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(70, 90);
  ctx.lineTo(150, 50);
  ctx.stroke();
  return canvas;
}

function makeChecker(): Canvas {
  const canvas = createCanvas(64, 32);
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#facc15' : '#0f172a';
      ctx.fillRect(x * 8, y * 8, 8, 8);
    }
  }
  return canvas;
}

const screenshot = makeScreenshot();
const checker = makeChecker();

const env: RenderEnv = {
  screenshot,
  image: (ref) => (ref === 'builtin:checker' ? checker : undefined),
  createContext: (w, h) => createCanvas(w, h).getContext('2d'),
};

/** A plain frame on a flat background: every case changes only what it tests. */
function sceneWith(patch: {
  frame?: Partial<Scene['frame']>;
  output?: Partial<Scene['output']>;
  layers?: BackgroundLayer[];
  viewBox?: [number, number, number, number];
}): Scene {
  const base = defaultScene({ width: 160, height: 100 });
  return {
    ...base,
    frame: {
      ...base.frame,
      padding: 20,
      radius: 0,
      shadows: [],
      ...patch.frame,
    },
    background: {
      ...base.background,
      viewBox: patch.viewBox ?? [0, 0, 100, 100],
      layers: patch.layers ?? [{ type: 'solid', color: '#6366f1' }],
    },
    output: { ...base.output, ...patch.output },
  };
}

function renderScene(scene: Scene, width?: number, height?: number): Canvas {
  const size = outputSize(scene, 1);
  const canvas = createCanvas(width ?? size.width, height ?? size.height);
  render(scene, 0, canvas.getContext('2d'), env);
  return canvas;
}

function pixels(canvas: Canvas): Uint8ClampedArray {
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
}

async function expectMatchesSnapshot(name: string, canvas: Canvas): Promise<void> {
  const file = join(SNAPSHOT_DIR, `${name}.png`);
  const png = canvas.toBuffer('image/png');
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(file, png);
    return;
  }
  if (!existsSync(file)) {
    throw new Error(`Missing snapshot ${file}. Run with UPDATE_SNAPSHOTS=1 to create it.`);
  }
  const expected = await loadImage(readFileSync(file));
  const fail = (reason: string): never => {
    const actualPath = join(tmpdir(), `cropa-core-${name}-actual.png`);
    writeFileSync(actualPath, png);
    throw new Error(`${name}: ${reason}. Actual image written to ${actualPath}`);
  };
  if (expected.width !== canvas.width || expected.height !== canvas.height) {
    fail(`size ${canvas.width}x${canvas.height}, expected ${expected.width}x${expected.height}`);
  }
  const ref = createCanvas(expected.width, expected.height);
  const refCtx = ref.getContext('2d');
  refCtx.drawImage(expected, 0, 0);
  const want = pixels(ref);
  const got = pixels(canvas);
  let differing = 0;
  for (let i = 0; i < want.length; i += 4) {
    for (let c = 0; c < 4; c += 1) {
      if (Math.abs((want[i + c] ?? 0) - (got[i + c] ?? 0)) > 3) {
        differing += 1;
        break;
      }
    }
  }
  const total = want.length / 4;
  if (differing / total > 0.001) {
    fail(`${differing} of ${total} pixels differ`);
  }
}

describe('outputSize', () => {
  it('adds padding around the screenshot', () => {
    expect(outputSize(sceneWith({}))).toEqual({ width: 200, height: 140 });
  });

  it('adds border, inset and padding', () => {
    const scene = sceneWith({
      frame: { border: { width: 4, color: '#000000' }, inset: 10 },
    });
    expect(outputSize(scene)).toEqual({ width: 228, height: 168 });
  });

  it('widens the frame to reach a wider aspect ratio', () => {
    expect(outputSize(sceneWith({ output: { aspectRatio: [16, 9] } }))).toEqual({
      width: 249,
      height: 140,
    });
  });

  it('heightens the frame to reach a taller aspect ratio', () => {
    expect(outputSize(sceneWith({ output: { aspectRatio: [1, 1] } }))).toEqual({
      width: 200,
      height: 200,
    });
  });

  it('honours a fixed width and keeps the aspect', () => {
    expect(outputSize(sceneWith({ output: { width: 100 } }))).toEqual({ width: 100, height: 70 });
  });

  it('multiplies by the scale', () => {
    expect(outputSize(sceneWith({}), 2)).toEqual({ width: 400, height: 280 });
  });
});

describe('render', () => {
  it('rejects a time outside [0, 1)', () => {
    const ctx = createCanvas(10, 10).getContext('2d');
    expect(() => {
      render(sceneWith({}), 1, ctx, env);
    }).toThrow(RangeError);
  });

  it('copies the screenshot pixel for pixel at 1x', () => {
    const out = renderScene(sceneWith({}));
    const got = out.getContext('2d').getImageData(20, 20, 160, 100).data;
    const want = screenshot.getContext('2d').getImageData(0, 0, 160, 100).data;
    expect(Buffer.from(got).equals(Buffer.from(want))).toBe(true);
  });

  it('leaves the caller context state alone', () => {
    const ctx = createCanvas(200, 140).getContext('2d');
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#123456';
    render(sceneWith({}), 0, ctx, env);
    expect(ctx.globalAlpha).toBe(0.5);
    expect(ctx.fillStyle).toBe('#123456');
  });

  it('skips an image layer whose image is missing', () => {
    const solid: BackgroundLayer = { type: 'solid', color: '#6366f1' };
    const withMissing = renderScene(
      sceneWith({ layers: [solid, { type: 'image', ref: 'user:gone', fit: 'cover' }] }),
    );
    const without = renderScene(sceneWith({ layers: [solid] }));
    expect(Buffer.from(pixels(withMissing)).equals(Buffer.from(pixels(without)))).toBe(true);
  });

  it('leaves no dark fringe at rounded corners when a shadow is transparent', () => {
    const white = createCanvas(160, 100);
    const wctx = white.getContext('2d');
    wctx.fillStyle = '#ffffff';
    wctx.fillRect(0, 0, 160, 100);
    const scene = sceneWith({
      frame: { radius: 16, shadows: [{ x: 0, y: 6, blur: 10, color: '#00000000' }] },
      layers: [{ type: 'solid', color: '#ffffff' }],
    });
    const out = createCanvas(outputSize(scene).width, outputSize(scene).height);
    render(scene, 0, out.getContext('2d'), { ...env, screenshot: white });
    expect(Math.min(...pixels(out))).toBeGreaterThanOrEqual(250);
  });

  it('keeps the background opaque when a blur radius is huge for a tiny viewBox', () => {
    const scene = sceneWith({
      viewBox: [0, 0, 1, 1],
      layers: [
        { type: 'solid', color: '#ef4444' },
        { type: 'blur', radius: 100 },
      ],
    });
    const out = renderScene(scene);
    const data = pixels(out);
    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(255);
    expect(data[0]).toBeGreaterThan(200);
  });

  it('uses a separate seed for each noise layer', () => {
    const one: BackgroundLayer = { type: 'noise', grain: 2, seed: 1 };
    const two: BackgroundLayer = { type: 'noise', grain: 2, seed: 999, opacity: 0.5 };
    const alone = renderScene(sceneWith({ layers: [one] }));
    const both = renderScene(sceneWith({ layers: [one, two] }));
    expect(Buffer.from(pixels(alone)).equals(Buffer.from(pixels(both)))).toBe(false);
  });

  it('draws noise with the same look at half the canvas size', () => {
    const scene = sceneWith({
      viewBox: [0, 0, 200, 140],
      layers: [{ type: 'noise', grain: 1, seed: 5 }],
    });
    const full = renderScene(scene);
    const half = renderScene(scene, 100, 70);
    const down = createCanvas(100, 70);
    down.getContext('2d').drawImage(full, 0, 0, 100, 70);
    // Standard deviation of the red channel over the top strip (background only).
    const spread = (c: Canvas): number => {
      const strip = c.getContext('2d').getImageData(0, 0, 100, 8).data;
      const values: number[] = [];
      for (let i = 0; i < strip.length; i += 4) values.push(strip[i] ?? 0);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
    };
    expect(spread(half) / spread(down)).toBeGreaterThan(0.8);
    expect(spread(half) / spread(down)).toBeLessThan(1.25);
  });

  const frameCases: [string, Scene, number?][] = [
    ['frame-plain', sceneWith({})],
    ['frame-radius', sceneWith({ frame: { radius: 16 } })],
    [
      'frame-shadows',
      sceneWith({
        frame: {
          padding: 36,
          radius: 10,
          shadows: [
            { x: 0, y: 10, blur: 20, color: '#00000066' },
            { x: 0, y: 2, blur: 4, color: '#00000040' },
          ],
        },
        layers: [{ type: 'solid', color: '#e5e7eb' }],
      }),
    ],
    [
      'frame-border',
      sceneWith({ frame: { radius: 10, border: { width: 4, color: '#facc15' } } }),
    ],
    ['frame-inset-auto', sceneWith({ frame: { radius: 10, inset: 14, insetColor: 'auto' } })],
    ['frame-inset-color', sceneWith({ frame: { radius: 10, inset: 14, insetColor: '#111827' } })],
    ['aspect-16x9', sceneWith({ output: { aspectRatio: [16, 9] } })],
    ['aspect-1x1-tall', sceneWith({ output: { aspectRatio: [1, 1] } })],
    ['export-width', sceneWith({ frame: { radius: 8 }, output: { width: 120 } })],
    ['scale-2x', sceneWith({ frame: { radius: 8 } }), 2],
  ];

  it.each(frameCases)('frame: %s', async (name, scene, scale = 1) => {
    const size = outputSize(scene, scale);
    await expectMatchesSnapshot(name, renderScene(scene, size.width, size.height));
  });

  it('frame: fit-preview (canvas half the output size)', async () => {
    const scene = sceneWith({ frame: { radius: 10, border: { width: 3, color: '#ffffff' } } });
    const size = outputSize(scene, 1);
    const canvas = renderScene(scene, size.width / 2, size.height / 2);
    await expectMatchesSnapshot('fit-preview', canvas);
  });

  const stops = [
    { offset: 0, color: '#f97316' },
    { offset: 0.5, color: '#ec4899' },
    { offset: 1, color: '#6366f1' },
  ];
  const backgroundCases: [string, BackgroundLayer[]][] = [
    ['bg-solid', [{ type: 'solid', color: '#0ea5e9' }]],
    ['bg-linear', [{ type: 'linear', angle: 90, stops }]],
    ['bg-radial', [{ type: 'radial', cx: 30, cy: 30, r: 80, stops }]],
    ['bg-conic', [{ type: 'conic', cx: 50, cy: 50, angle: 0, stops }]],
    [
      'bg-mesh',
      [
        { type: 'solid', color: '#0f172a' },
        {
          type: 'mesh',
          points: [
            { x: 10, y: 10, r: 60, color: '#f43f5e' },
            { x: 90, y: 20, r: 60, color: '#22d3ee' },
            { x: 50, y: 95, r: 70, color: '#facc15' },
          ],
        },
      ],
    ],
    [
      'bg-noise',
      [
        { type: 'solid', color: '#334155' },
        { type: 'noise', grain: 4, seed: 7, opacity: 0.4 },
      ],
    ],
    [
      'bg-shape',
      [
        { type: 'solid', color: '#1e293b' },
        { type: 'shape', shape: 'ellipse', x: 5, y: 5, w: 60, h: 40, rotation: 0, color: '#38bdf8' },
        { type: 'shape', shape: 'rect', x: 45, y: 40, w: 50, h: 50, rotation: 30, color: '#f472b6' },
      ],
    ],
    ['bg-image', [{ type: 'image', ref: 'builtin:checker', fit: 'cover' }]],
    [
      'bg-blur',
      [
        { type: 'solid', color: '#ffffff' },
        { type: 'shape', shape: 'rect', x: 0, y: 0, w: 50, h: 100, rotation: 0, color: '#ef4444' },
        { type: 'shape', shape: 'ellipse', x: 55, y: 25, w: 40, h: 50, rotation: 0, color: '#2563eb' },
        { type: 'blur', radius: 6 },
      ],
    ],
  ];

  it.each(backgroundCases)('background: %s', async (name, layers) => {
    await expectMatchesSnapshot(name, renderScene(sceneWith({ frame: { padding: 30 }, layers })));
  });
});

describe('built-in presets', () => {
  /** Every preset behind the test screenshot with the default frame, 4 tiles per row. */
  function contactSheet(scale: number): Canvas {
    const base = defaultScene({ width: 160, height: 100 });
    const tile = outputSize(base, scale);
    const columns = 4;
    const rows = Math.ceil(builtinPresets.length / columns);
    const sheet = createCanvas(tile.width * columns, tile.height * rows);
    const sheetCtx = sheet.getContext('2d');
    sheetCtx.fillStyle = '#ffffff';
    sheetCtx.fillRect(0, 0, sheet.width, sheet.height);
    for (const [i, preset] of builtinPresets.entries()) {
      const canvas = createCanvas(tile.width, tile.height);
      render({ ...base, background: preset.background }, 0, canvas.getContext('2d'), env);
      sheetCtx.drawImage(canvas, (i % columns) * tile.width, Math.floor(i / columns) * tile.height);
    }
    return sheet;
  }

  it('renders the contact sheet', async () => {
    await expectMatchesSnapshot('presets-contact-sheet', contactSheet(1));
  });
});

describe('performance', () => {
  it('logs render time at 2x for a 1920x1080 screenshot', { timeout: 60_000 }, () => {
    const big = makeScreenshot(1920, 1080);
    const bigEnv: RenderEnv = { ...env, screenshot: big };
    const timeIt = (scene: Scene): number => {
      const size = outputSize(scene, 2);
      const canvas = createCanvas(size.width, size.height);
      const ctx = canvas.getContext('2d');
      render(scene, 0, ctx, bigEnv); // warm-up
      ctx.getImageData(0, 0, 1, 1);
      const start = performance.now();
      render(scene, 0, ctx, bigEnv);
      ctx.getImageData(0, 0, 1, 1); // Skia may defer drawing until pixels are read
      return performance.now() - start;
    };

    const plain = defaultScene({ width: 1920, height: 1080 });
    const heavy: Scene = {
      ...plain,
      background: {
        ...plain.background,
        layers: [
          { type: 'solid', color: '#0f172a' },
          {
            type: 'mesh',
            points: [
              { x: 100, y: 100, r: 700, color: '#f43f5e' },
              { x: 900, y: 200, r: 700, color: '#22d3ee' },
              { x: 500, y: 950, r: 800, color: '#facc15' },
            ],
          },
          { type: 'noise', grain: 1, seed: 1, opacity: 0.2 },
          { type: 'blur', radius: 20 },
        ],
      },
    };
    console.log(`render 1920x1080 @2x, default scene: ${timeIt(plain).toFixed(0)} ms`);
    console.log(`render 1920x1080 @2x, mesh + noise + blur: ${timeIt(heavy).toFixed(0)} ms`);
  });
});
