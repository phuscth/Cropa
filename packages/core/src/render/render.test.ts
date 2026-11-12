// Image snapshot tests for the renderer. Expected images live in ./__snapshots__.
// A missing snapshot fails. To (re)write them after a deliberate change, then review the PNGs:
//   PowerShell: $env:UPDATE_SNAPSHOTS=1; pnpm --filter @cropa/core test
//   POSIX:      UPDATE_SNAPSHOTS=1 pnpm --filter @cropa/core test
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import type { Annotation } from '../schema/annotation.ts';
import { defaultScene } from '../schema/scene.ts';
import type { Scene } from '../schema/scene.ts';
import type { BackgroundLayer } from '../schema/background.ts';
import type { RenderEnv } from './canvas.ts';
import { outputSize, screenshotRect } from './layout.ts';
import { render } from './render.ts';

const SNAPSHOT_DIR = join(import.meta.dirname, '__snapshots__');

// Text snapshots need the same glyphs on every machine. The Inter weights the
// renderer asks for come from the @fontsource/inter dev dependency (OFL-1.1, never
// shipped); a missing font fails here instead of silently falling back.
const interDir = join(
  dirname(createRequire(import.meta.url).resolve('@fontsource/inter/package.json')),
  'files',
);
for (const weight of [600, 700]) {
  GlobalFonts.registerFromPath(join(interDir, `inter-latin-${weight}-normal.woff2`), 'Inter');
}
if (!GlobalFonts.has('Inter')) throw new Error('The Inter test font did not load');

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

/** A screenshot with fine detail (stripes and text) so a redaction is easy to see. */
function makeDetailedScreenshot(): Canvas {
  const canvas = createCanvas(160, 100);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f4f5';
  ctx.fillRect(0, 0, 160, 100);
  ctx.fillStyle = '#1e293b';
  for (let x = 0; x < 160; x += 6) ctx.fillRect(x, 0, 2, 22);
  ctx.fillStyle = '#0ea5e9';
  ctx.fillRect(0, 22, 160, 8);
  ctx.fillStyle = '#111827';
  ctx.font = '600 12px Inter';
  ctx.fillText('Card 4242 1234', 10, 48);
  ctx.fillText('Name: A. Reader', 10, 64);
  ctx.fillStyle = '#16a34a';
  for (let x = 100; x < 150; x += 4) ctx.fillRect(x, 40, 2, 50);
  return canvas;
}

function mark(type: Annotation['type'], box: Annotation['box'], rest: Partial<Annotation> = {}): Annotation {
  return { version: 1, type, box, ...rest };
}

function renderWith(
  renderEnv: RenderEnv,
  scene: Scene,
  scale = 1,
): { canvas: Canvas; rect: ReturnType<typeof screenshotRect> } {
  const size = outputSize(scene, scale);
  const canvas = createCanvas(size.width, size.height);
  render(scene, 0, canvas.getContext('2d'), renderEnv);
  return { canvas, rect: screenshotRect(scene, size.width, size.height) };
}

describe('annotations', () => {
  const detailEnv: RenderEnv = { ...env, screenshot: makeDetailedScreenshot() };
  const withMarks = (
    annotations: Annotation[],
    patch: Parameters<typeof sceneWith>[0] = {},
  ): Scene => ({ ...sceneWith({ frame: { radius: 6 }, ...patch }), annotations });

  const mixed = [
    mark('blur', [10, 36, 100, 32], { style: { strength: 8 } }),
    mark('pixelate', [112, 40, 40, 50], { style: { strength: 8 } }),
    mark('rect', [6, 4, 148, 90], { style: { color: '#f59e0b', strokeWidth: 3, radius: 8 } }),
    mark('arrow', [140, 8, -40, 24], { style: { color: '#2563eb', strokeWidth: 3 } }),
    mark('step', [4, 70, 22, 22]),
    mark('text', [34, 72, 0, 0], {
      text: 'Hide this',
      style: { fontSize: 11, color: '#ffffff', fill: '#111827' },
    }),
  ];

  const cases: [string, Scene, number?][] = [
    [
      'ann-arrow',
      withMarks([
        mark('arrow', [15, 85, 60, -60]),
        mark('arrow', [145, 15, -60, 50], { style: { color: '#2563eb', strokeWidth: 6 } }),
        mark('arrow', [20, 20, 100, 0], { style: { color: '#16a34a', strokeWidth: 2 } }),
        mark('arrow', [90, 92, -75, 0], { style: { color: '#7c3aed', strokeWidth: 3 } }),
      ]),
    ],
    [
      'ann-rect',
      withMarks([
        mark('rect', [10, 10, 60, 40]),
        mark('rect', [90, 60, -70, -40], {
          style: { color: '#2563eb', fill: '#2563eb33', strokeWidth: 3, radius: 10 },
        }),
        mark('rect', [100, 15, 50, 30], { style: { fill: '#facc1599', strokeWidth: 1 } }),
      ]),
    ],
    [
      'ann-text',
      withMarks([
        mark('text', [10, 8, 0, 0], { text: 'Plain label', style: { fontSize: 14 } }),
        mark('text', [10, 34, 0, 0], {
          text: 'Two lines\nwith a pill',
          style: { fontSize: 14, color: '#ffffff', fill: '#111827' },
        }),
        mark('text', [10, 80, 140, 16], {
          text: 'Box wider than text',
          style: { fontSize: 11, color: '#111827', fill: '#fde68a' },
        }),
      ]),
    ],
    [
      'ann-step',
      withMarks([
        mark('step', [12, 10, 24, 24]),
        mark('step', [60, 40, 24, 24], { style: { color: '#16a34a' } }),
        mark('step', [110, 66, 24, 24], { style: { color: '#facc15' } }),
        mark('step', [100, 10, 30, 30], { text: 'A', style: { color: '#2563eb' } }),
      ]),
    ],
    ['ann-blur', withMarks([mark('blur', [8, 36, 100, 32], { style: { strength: 8 } })])],
    ['ann-pixelate', withMarks([mark('pixelate', [8, 36, 100, 32], { style: { strength: 8 } })])],
    ['ann-mixed-2x', withMarks(mixed), 2],
    [
      'ann-mixed-aspect',
      withMarks(mixed, {
        frame: { radius: 10, padding: 24, inset: 6, insetColor: '#ffffff', border: { width: 3, color: '#facc15' } },
        output: { aspectRatio: [16, 9] },
      }),
    ],
  ];

  it.each(cases)('snapshot: %s', async (name, scene, scale = 1) => {
    await expectMatchesSnapshot(name, renderWith(detailEnv, scene, scale).canvas);
  });

  it('derives the automatic inset colour from the redacted screenshot', () => {
    const src = createCanvas(64, 64);
    const sctx = src.getContext('2d');
    sctx.fillStyle = '#000000';
    sctx.fillRect(0, 0, 64, 64);
    sctx.fillStyle = '#ffffff';
    sctx.fillRect(0, 0, 64, 8);
    sctx.fillRect(0, 56, 64, 8);
    sctx.fillRect(0, 0, 8, 64);
    sctx.fillRect(56, 0, 8, 64);
    const base = defaultScene({ width: 64, height: 64 });
    const scene: Scene = {
      ...base,
      frame: { ...base.frame, padding: 20, inset: 10, insetColor: 'auto', radius: 0, shadows: [] },
      annotations: [mark('pixelate', [0, 0, 64, 64], { style: { strength: 256 } })],
    };
    const { canvas } = renderWith({ ...env, screenshot: src }, scene);
    // The inset ring sits at x 20..30; the white edge must not leak into it.
    const p = canvas.getContext('2d').getImageData(25, 50, 1, 1).data;
    expect(p[0]).toBeGreaterThan(90);
    expect(p[0]).toBeLessThan(135);
  });

  describe('alignment', () => {
    const flat = createCanvas(160, 100);
    const flatCtx = flat.getContext('2d');
    flatCtx.fillStyle = '#f4f4f5';
    flatCtx.fillRect(0, 0, 160, 100);
    const flatEnv: RenderEnv = { ...env, screenshot: flat };

    // A 1-px stroke on x = 10.5 covers image column 10 exactly. The expected canvas
    // columns follow from the layout arithmetic written out here, not from the renderer.
    it.each([
      ['padding, 1x', {}, 1, 20, 20],
      ['padding, 2x', {}, 2, 40, 40],
      ['3:1 aspect, 1x', { output: { aspectRatio: [3, 1] as [number, number] } }, 1, 130, 20],
      ['3:1 aspect, 2x', { output: { aspectRatio: [3, 1] as [number, number] } }, 2, 260, 40],
    ])('lands a rect edge on the right pixels: %s', (_name, patch, scale, shotX, shotY) => {
      const scene = {
        ...sceneWith(patch),
        annotations: [
          mark('rect', [10.5, 10.5, 20, 20], { style: { color: '#ff0000', strokeWidth: 1 } }),
        ],
      };
      const { canvas } = renderWith(flatEnv, scene, scale);
      const ctx = canvas.getContext('2d');
      const isRed = (x: number): boolean => {
        const p = ctx.getImageData(x, shotY + 20 * scale, 1, 1).data;
        return (p[0] ?? 0) > 240 && (p[1] ?? 255) < 20;
      };
      const first = shotX + 10 * scale;
      const last = first + scale - 1;
      expect(isRed(first - 1)).toBe(false);
      for (let x = first; x <= last; x += 1) expect(isRed(x)).toBe(true);
      expect(isRed(last + 1)).toBe(false);
    });
  });

  describe('redaction', () => {
    const W = 128;
    const H = 96;
    const BOX: Annotation['box'] = [8, 8, 112, 80];
    // Pixels this far from the box edge are unaffected by edge clamping.
    const MARGIN = 16;

    function checkerEnv(phase: number): RenderEnv {
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext('2d');
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          ctx.fillStyle = (x + y + phase) % 2 === 0 ? '#000000' : '#ffffff';
          ctx.fillRect(x, y, 1, 1);
        }
      }
      return { ...env, screenshot: canvas };
    }

    function redactScene(type: 'blur' | 'pixelate', width: number | null): Scene {
      const base = defaultScene({ width: W, height: H });
      return {
        ...base,
        frame: { ...base.frame, padding: 20, radius: 0, shadows: [] },
        annotations: [mark(type, BOX, { style: { strength: 8 } })],
        output: { ...base.output, width },
      };
    }

    const cases: [string, 'blur' | 'pixelate', number | null, number][] = [];
    for (const type of ['blur', 'pixelate'] as const) {
      cases.push([`${type} 1x`, type, null, 1], [`${type} 2x`, type, null, 2]);
      cases.push([`${type} odd output width`, type, 247, 1]);
    }

    it.each(cases)('removes the pattern under a box: %s', (_name, type, width, scale) => {
      const { canvas, rect } = renderWith(checkerEnv(0), redactScene(type, width), scale);
      const ctx = canvas.getContext('2d');
      const k = rect.w / W;
      const x0 = Math.ceil(rect.x + (BOX[0] + MARGIN) * k);
      const y0 = Math.ceil(rect.y + (BOX[1] + MARGIN) * k);
      const x1 = Math.floor(rect.x + (BOX[0] + BOX[2] - MARGIN) * k);
      const y1 = Math.floor(rect.y + (BOX[1] + BOX[3] - MARGIN) * k);
      const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      for (let c = 0; c < 3; c += 1) {
        let min = 255;
        let max = 0;
        for (let i = c; i < data.length; i += 4) {
          min = Math.min(min, data[i] ?? 0);
          max = Math.max(max, data[i] ?? 0);
        }
        expect(max - min).toBeLessThanOrEqual(8);
      }
    });

    it.each(['blur', 'pixelate'] as const)(
      'changes every pixel in the box and leaves the rest alone at 1x: %s',
      (type) => {
        const source = checkerEnv(0);
        const { canvas } = renderWith(source, redactScene(type, null));
        const got = canvas.getContext('2d').getImageData(20, 20, W, H).data;
        const want = (source.screenshot as Canvas).getContext('2d').getImageData(0, 0, W, H).data;
        for (let y = 0; y < H; y += 1) {
          for (let x = 0; x < W; x += 1) {
            const i = (y * W + x) * 4;
            const inBox = x >= BOX[0] && x < BOX[0] + BOX[2] && y >= BOX[1] && y < BOX[1] + BOX[3];
            const diff = Math.max(
              ...[0, 1, 2].map((c) => Math.abs((got[i + c] ?? 0) - (want[i + c] ?? 0))),
            );
            if (inBox) expect(diff).toBeGreaterThan(60);
            else expect(diff).toBe(0);
          }
        }
      },
    );

    it.each(['blur', 'pixelate'] as const)(
      'does not depend on the original pixels under the box: %s',
      (type) => {
        const scene = redactScene(type, null);
        const a = renderWith(checkerEnv(0), scene, 2);
        const b = renderWith(checkerEnv(1), scene, 2);
        const k = a.rect.w / W;
        const x = Math.ceil(a.rect.x + (BOX[0] + MARGIN) * k);
        const y = Math.ceil(a.rect.y + (BOX[1] + MARGIN) * k);
        const w = Math.floor((BOX[2] - 2 * MARGIN) * k);
        const h = Math.floor((BOX[3] - 2 * MARGIN) * k);
        const da = a.canvas.getContext('2d').getImageData(x, y, w, h).data;
        const db = b.canvas.getContext('2d').getImageData(x, y, w, h).data;
        let worst = 0;
        for (let i = 0; i < da.length; i += 1) worst = Math.max(worst, Math.abs((da[i] ?? 0) - (db[i] ?? 0)));
        expect(worst).toBeLessThanOrEqual(4);
      },
    );
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
    const annotated: Scene = {
      ...plain,
      annotations: [
        mark('blur', [200, 200, 400, 200]),
        mark('pixelate', [800, 500, 400, 200]),
        mark('arrow', [100, 900, 300, -200]),
        mark('text', [700, 100, 0, 0], { text: 'Annotated', style: { fontSize: 48 } }),
      ],
    };
    console.log(
      `render 1920x1080 @2x, two 400x200 redactions + arrow + text: ${timeIt(annotated).toFixed(0)} ms`,
    );
  });
});
