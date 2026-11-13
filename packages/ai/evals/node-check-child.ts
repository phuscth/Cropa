// The checker itself: it runs inside the child process `node-check.ts` starts under the Node
// permission model, reads one request from stdin and prints one JSON line. It loads AI-written
// background modules in a vm the way the desktop sandbox does, using the real sandbox worker
// runtime and wrapper; only the canvas is replaced by a recording stub and WebGL by a stub
// renderer that records what it would draw. The vm is not the security boundary: the process
// permissions are.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
  CodeSandboxError,
  truncateMessage,
  type CodeSandboxErrorKind,
} from '../../../apps/desktop/src/features/code-sandbox/errors.ts';
import {
  composeWorkerSource,
  MAX_SOURCE_BYTES,
  sourceBytes,
  usesThree,
} from '../../../apps/desktop/src/features/code-sandbox/compose-worker.ts';

import type { NodeCheck, NodeScene, ResolvedNodeCheckOptions } from './node-check.ts';

const runtime = readFileSync(
  new URL('../../../apps/desktop/src/features/code-sandbox/worker-runtime.js', import.meta.url),
  'utf8',
);

type Op = unknown[];
type Message = Record<string, unknown>;

const round = (value: number, step = 0.1): number => {
  const rounded = Math.round(value / step) * step;
  // Drop -0 and the float noise of the multiplication.
  return rounded === 0 ? 0 : Number(rounded.toFixed(4));
};

/** Numbers in a colour string are rounded, and an hsl hue wraps, so 360 and 0 compare equal. */
function normString(text: string): string {
  return text
    .replace(/(hsla?\(\s*)(-?\d+(?:\.\d+)?)(?:deg)?/gi, (_all, head: string, hue: string) =>
      `${head}${String((((round(Number(hue)) % 360) + 360) % 360))}`,
    )
    .replace(/-?\d+\.\d+(?:e[+-]?\d+)?/gi, (n) => String(round(Number(n))));
}

class StubCanvas {
  width: number;
  height: number;
  /** What the 2D context drew since the last reset or transfer. */
  ops: Op[] = [];
  /** What the stub WebGL renderer drew last. */
  render: Op[] | null = null;
  gradients = 0;
  #context: object | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext(kind: string): object | null {
    if (kind === 'webgl2' || kind === 'webgl') return {};
    if (kind !== '2d') return null;
    this.#context ??= recordingContext(this);
    return this.#context;
  }

  clear(): void {
    this.ops = [];
    this.gradients = 0;
  }

  transferToImageBitmap(): { width: number; height: number; ops: Op[]; close(): void } {
    const bitmap = { width: this.width, height: this.height, ops: this.ops, close: () => undefined };
    this.clear();
    return bitmap;
  }
}

class RecordedGradient {
  readonly id: number;
  readonly #canvas: StubCanvas;

  constructor(canvas: StubCanvas, id: number) {
    this.#canvas = canvas;
    this.id = id;
  }

  addColorStop(offset: number, color: string): void {
    this.#canvas.ops.push(['addColorStop', this.id, norm(offset), norm(color)]);
  }
}

class RecordedPattern {
  readonly id: number;

  constructor(id: number) {
    this.id = id;
  }
}

const PATH_METHODS = [
  'moveTo',
  'lineTo',
  'bezierCurveTo',
  'quadraticCurveTo',
  'arc',
  'arcTo',
  'ellipse',
  'rect',
  'roundRect',
  'closePath',
  'addPath',
] as const;

class RecordedPath {
  readonly ops: Op[] = [];

  constructor(d?: unknown) {
    if (d !== undefined) this.ops.push(['d', norm(d)]);
  }
}
for (const name of PATH_METHODS) {
  Object.defineProperty(RecordedPath.prototype, name, {
    value(this: RecordedPath, ...args: unknown[]) {
      this.ops.push([name, ...args.map(norm)]);
    },
  });
}

/** A value as it goes into the op list: rounded numbers, canvases and gradients by content. */
function norm(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? round(value) : String(value);
  if (typeof value === 'string') return normString(value);
  if (value === null || typeof value === 'boolean') return value;
  if (value === undefined) return null;
  if (typeof value === 'function') return 'function';
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return Array.from(value as ArrayLike<unknown>, norm);
  }
  if (value instanceof RecordedGradient) return { gradient: value.id };
  if (value instanceof RecordedPattern) return { pattern: value.id };
  if (value instanceof RecordedPath) return { path: value.ops };
  if (value instanceof StubCanvas) return { canvas: { ops: value.ops.slice(), render: value.render } };
  if (typeof value === 'object' && 'ops' in value && 'width' in value && 'height' in value) {
    return { bitmap: [value.width, value.height] };
  }
  return { object: Object.prototype.toString.call(value) };
}

const ATTRIBUTE_DEFAULTS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['globalAlpha', 1],
  ['globalCompositeOperation', 'source-over'],
  ['fillStyle', '#000000'],
  ['strokeStyle', '#000000'],
  ['lineWidth', 1],
  ['lineCap', 'butt'],
  ['lineJoin', 'miter'],
  ['miterLimit', 10],
  ['lineDashOffset', 0],
  ['font', '10px sans-serif'],
  ['textAlign', 'start'],
  ['textBaseline', 'alphabetic'],
  ['direction', 'ltr'],
  ['letterSpacing', '0px'],
  ['wordSpacing', '0px'],
  ['fontKerning', 'auto'],
  ['fontStretch', 'normal'],
  ['fontVariantCaps', 'normal'],
  ['textRendering', 'auto'],
  ['shadowBlur', 0],
  ['shadowOffsetX', 0],
  ['shadowOffsetY', 0],
  ['shadowColor', 'rgba(0, 0, 0, 0)'],
  ['filter', 'none'],
  ['imageSmoothingEnabled', true],
  ['imageSmoothingQuality', 'low'],
]);

function fontSize(font: unknown): number {
  const match = typeof font === 'string' ? /(\d+(?:\.\d+)?)px/.exec(font) : null;
  return match?.[1] === undefined ? 10 : Number(match[1]);
}

/** A 2D context that does not draw: every call and property set goes into `canvas.ops`. */
function recordingContext(canvas: StubCanvas): object {
  const state = new Map<string, unknown>();
  const record = (...op: unknown[]): void => {
    canvas.ops.push(op.map(norm));
  };
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    reset: () => {
      canvas.clear();
      state.clear();
    },
    createLinearGradient: (...args) => gradient('createLinearGradient', args),
    createRadialGradient: (...args) => gradient('createRadialGradient', args),
    createConicGradient: (...args) => gradient('createConicGradient', args),
    createPattern: (...args) => {
      const id = canvas.gradients++;
      record('createPattern', id, args[1]);
      return new RecordedPattern(id);
    },
    measureText: (text) => {
      const size = fontSize(state.get('font'));
      const width = String(text).length * size * 0.6;
      return {
        width,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        actualBoundingBoxAscent: size * 0.8,
        actualBoundingBoxDescent: size * 0.2,
        fontBoundingBoxAscent: size * 0.9,
        fontBoundingBoxDescent: size * 0.25,
      };
    },
    getImageData: (...args) => blank(args[2], args[3]),
    createImageData: (...args) => blank(args[0], args[1]),
    getLineDash: () => state.get('lineDash') ?? [],
    setLineDash: (segments) => {
      state.set('lineDash', segments);
      record('setLineDash', segments);
    },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false,
    isPointInStroke: () => false,
  };

  function gradient(name: string, args: unknown[]): RecordedGradient {
    const id = canvas.gradients++;
    record(name, id, ...args);
    return new RecordedGradient(canvas, id);
  }

  function blank(width: unknown, height: unknown): { width: number; height: number; data: Uint8ClampedArray } {
    const w = Math.max(0, Math.floor(Number(width)) || 0);
    const h = Math.max(0, Math.floor(Number(height)) || 0);
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }

  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'canvas') return canvas;
        const method = methods[prop];
        if (method) return method;
        if (ATTRIBUTE_DEFAULTS.has(prop)) {
          return state.has(prop) ? state.get(prop) : ATTRIBUTE_DEFAULTS.get(prop);
        }
        return (...args: unknown[]) => {
          record(prop, ...args);
        };
      },
      set(_target, prop, value) {
        if (typeof prop === 'symbol') return true;
        state.set(prop, value);
        record(`=${prop}`, value);
        return true;
      },
    },
  );
}

// ---------------------------------------------------------------------------------- three.js

interface Matrix {
  elements: ArrayLike<number>;
}

interface Object3D {
  updateMatrixWorld(force?: boolean): void;
  traverseVisible(callback: (object: Object3D) => void): void;
  matrixWorld: Matrix;
  projectionMatrix?: Matrix;
  isMesh?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
  isSprite?: boolean;
  isLight?: boolean;
  intensity?: number;
  color?: { getHexString(): string };
  material?: unknown;
  geometry?: { attributes?: { position?: { array: ArrayLike<number> } } };
  instanceMatrix?: { array: ArrayLike<number> };
}

function matrixOf(matrix: Matrix | undefined): unknown {
  return matrix === undefined ? null : Array.from(matrix.elements, (v) => round(v, 0.01));
}

/** Enough of an array to notice that it moved, without listing every value. */
function checksum(values: ArrayLike<number> | undefined): unknown {
  if (values === undefined) return null;
  let sum = 0;
  let weighted = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    sum += v;
    weighted += v * ((i % 7) + 1);
  }
  return [values.length, round(sum, 0.01), round(weighted, 0.01)];
}

function materialOf(material: unknown): unknown {
  if (Array.isArray(material)) return material.map(materialOf);
  const m = material as { color?: { getHexString(): string }; opacity?: number } | undefined;
  return [m?.color?.getHexString() ?? null, round(m?.opacity ?? 1, 0.01)];
}

const NOOP: unknown = new Proxy(function noop() {}, {
  get: (_target, prop) => (typeof prop === 'symbol' || prop === 'then' ? undefined : NOOP),
  apply: () => undefined,
});

/** Takes any option, call or property set; `render` records what it would draw into its canvas. */
class StubRenderer {
  domElement: StubCanvas;

  constructor(params?: { canvas?: unknown }) {
    this.domElement = params?.canvas instanceof StubCanvas ? params.canvas : new StubCanvas(300, 150);
    return new Proxy(this, {
      get: (target, prop) => (prop in target ? Reflect.get(target, prop, target) : NOOP),
    });
  }

  setSize(width: number, height: number): void {
    this.domElement.width = width;
    this.domElement.height = height;
  }

  render(scene: Object3D, camera: Object3D): void {
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const ops: Op[] = [['camera', matrixOf(camera.matrixWorld), matrixOf(camera.projectionMatrix)]];
    scene.traverseVisible((object) => {
      if (object.isMesh || object.isPoints || object.isLine || object.isSprite) {
        ops.push([
          'object',
          matrixOf(object.matrixWorld),
          materialOf(object.material),
          object.isPoints ? checksum(object.geometry?.attributes?.position?.array) : null,
          checksum(object.instanceMatrix?.array),
        ]);
      } else if (object.isLight) {
        ops.push(['light', matrixOf(object.matrixWorld), object.color?.getHexString() ?? null, round(object.intensity ?? 1, 0.01)]);
      }
    });
    this.domElement.render = ops;
  }
}


// ------------------------------------------------------------------------------------- check

function moduleError(error: unknown): CodeSandboxError {
  const info = typeof error === 'object' && error !== null ? (error as Message) : null;
  const kinds: readonly string[] = ['timeout', 'source-too-large', 'module-error', 'no-webgl', 'sandbox-failed', 'disposed'];
  const kind = typeof info?.['kind'] === 'string' && kinds.includes(info['kind']) ? info['kind'] : 'module-error';
  const message = typeof info?.['message'] === 'string' ? info['message'] : 'The module failed without a message.';
  return new CodeSandboxError(kind as CodeSandboxErrorKind, truncateMessage(message));
}

function timedOut(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
}

interface Frame {
  back: Op[] | null;
  front: Op[] | null;
}

/**
 * Loads `source` in a fresh context, renders it over one loop and reports whether it errors,
 * stays within the frame time and closes the loop (the ops at t=1 equal the ops at t=0).
 */
function checkModuleSync(
  source: string,
  scene: NodeScene,
  options: ResolvedNodeCheckOptions,
  three: Record<string, unknown>,
): NodeCheck {
  const { samples, frameTimeoutMs, loadTimeoutMs } = options;
  let maxFrameMs = 0;

  const fail = (error: CodeSandboxError): NodeCheck => ({
    ok: false,
    error: { kind: error.kind, message: error.message },
    loops: false,
    maxFrameMs,
  });

  try {
    const bytes = sourceBytes(source);
    if (bytes > MAX_SOURCE_BYTES) {
      throw new CodeSandboxError(
        'source-too-large',
        `The source is ${String(bytes)} bytes; the limit is ${String(MAX_SOURCE_BYTES)} bytes. Write a shorter module.`,
      );
    }

    const inbox: Message[] = [];
    const listeners: ((event: { data: unknown }) => void)[] = [];
    const globals: Record<string, unknown> = {
      postMessage: (message: Message) => {
        inbox.push(message);
      },
      addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => {
        listeners.push(listener);
      },
      OffscreenCanvas: StubCanvas,
      Path2D: RecordedPath,
      THREE: three,
      structuredClone,
      performance,
      console: { log: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      setInterval: () => 0,
      clearInterval: () => undefined,
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => undefined,
      Worker: () => undefined,
      SharedWorker: () => undefined,
      __listeners: listeners,
      __message: null,
    };
    const context = vm.createContext(globals);
    vm.runInContext('globalThis.self = globalThis;', context);

    const code = composeWorkerSource(runtime, source, null);
    try {
      vm.runInContext(code, context, { timeout: loadTimeoutMs });
    } catch (error) {
      if (timedOut(error)) {
        throw new CodeSandboxError(
          'timeout',
          `The module did not finish loading within ${String(loadTimeoutMs)} ms. Remove loops that run at the top level.`,
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new CodeSandboxError('module-error', truncateMessage(`The module could not run: ${reason}`));
    }

    const loaded = inbox.find((m) => m['type'] === 'loaded');
    if (loaded === undefined) throw new CodeSandboxError('module-error', 'The module did not finish loading.');
    if (loaded['error'] !== undefined) throw moduleError(loaded['error']);
    const durationMs = loaded['durationMs'];
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 250 || durationMs > 60000) {
      throw new CodeSandboxError(
        'module-error',
        `meta.durationMs must be a number of milliseconds from 250 to 60000, got ${JSON.stringify(durationMs)}.`,
      );
    }

    let nextId = 0;
    // The first frame after a load can compile shaders, so it gets the longer limit.
    let first = true;
    const renderAt = (t: number): Frame => {
      const id = nextId++;
      const limitMs = first ? Math.max(frameTimeoutMs, loadTimeoutMs) : frameTimeoutMs;
      first = false;
      inbox.length = 0;
      globals['__message'] = { type: 'frame', id, t, scene: structuredClone(scene) };
      const timeout = () =>
        new CodeSandboxError(
          'timeout',
          `Rendering the frame at t=${String(t)} took longer than ${String(limitMs)} ms. Make back and front cheaper: fewer shapes, no loops that run long.`,
        );
      const started = performance.now();
      try {
        vm.runInContext('__listeners.forEach((listener) => listener({ data: __message }))', context, {
          timeout: limitMs,
        });
      } catch (error) {
        if (timedOut(error)) throw timeout();
        throw new CodeSandboxError('module-error', truncateMessage(`The module could not run: ${error instanceof Error ? error.message : String(error)}`));
      }
      const elapsed = performance.now() - started;
      maxFrameMs = Math.max(maxFrameMs, elapsed);
      if (elapsed > limitMs) throw timeout();

      const reply = inbox.find((m) => m['type'] === 'frame' && m['id'] === id);
      if (reply === undefined) throw new CodeSandboxError('module-error', 'The module did not return a frame.');
      if (reply['error'] !== undefined) throw moduleError(reply['error']);
      type Bitmap = { width: number; height: number; ops: Op[] };
      const { back, front } = reply as { back?: Bitmap | null; front?: Bitmap | null };
      if (back === null || back === undefined) {
        throw new CodeSandboxError('module-error', 'The sandbox returned a frame without bitmaps. back must draw on ctx and front is optional.');
      }
      for (const bitmap of [back, front]) {
        if (bitmap && (bitmap.width !== scene.width || bitmap.height !== scene.height)) {
          throw new CodeSandboxError(
            'module-error',
            `The frame is ${String(bitmap.width)}x${String(bitmap.height)} but the scene is ${String(scene.width)}x${String(scene.height)}. Do not resize ctx.canvas.`,
          );
        }
      }
      return { back: back.ops, front: front ? front.ops : null };
    };

    let firstFrame: Frame | null = null;
    for (let k = 0; k < samples; k++) {
      const frame = renderAt(k / samples);
      if (k === 0) firstFrame = frame;
    }
    const last = renderAt(1);
    const same = (a: Op[] | null, b: Op[] | null): boolean =>
      a === null || b === null ? a === b : JSON.stringify(a) === JSON.stringify(b);
    const loops = firstFrame !== null && same(firstFrame.back, last.back) && same(firstFrame.front, last.front);
    return { ok: true, loops, maxFrameMs, durationMs };
  } catch (error) {
    if (error instanceof CodeSandboxError) return fail(error);
    throw error;
  }
}

interface Request {
  source: string;
  scene: NodeScene;
  options: ResolvedNodeCheckOptions;
}

async function readStdin(): Promise<string> {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

const request = JSON.parse(await readStdin()) as Request;
// three is only needed, and only loaded, for a module that mentions it.
const three: Record<string, unknown> = usesThree(request.source)
  ? {
      ...((await import('three')) as unknown as Record<string, unknown>),
      WebGLRenderer: StubRenderer,
    }
  : {};
const result = checkModuleSync(request.source, request.scene, request.options, three);
process.stdout.write(JSON.stringify(result) + String.fromCharCode(10));
