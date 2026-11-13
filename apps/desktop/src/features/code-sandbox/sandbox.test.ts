/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BOOTSTRAP_CSP_HASH, BOOTSTRAP_SCRIPT, sandboxDocument } from './bootstrap.ts';
import { checkModule, framesMatch } from './check-module.ts';
import { MAX_ERROR_MESSAGE_CHARS, CodeSandboxError } from './errors.ts';
import { createIframeHost, type CreateHost, type HostMessage, type SandboxHost } from './host.ts';
import { createSandboxFrameSource } from './frame-source.ts';
import { createCodeSandbox, type CodeScene } from './sandbox.ts';
import { MAX_SOURCE_BYTES } from './worker-source.ts';

interface FakeBitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  close(): void;
}

interface FakeHost extends SandboxHost {
  sent: HostMessage[];
  disposed: boolean;
}

interface WorldOptions {
  webgl: boolean;
  silentFrames: boolean;
  silentLoad: boolean;
  bootFails: boolean;
}

interface StubCanvas {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function createContext(canvas: StubCanvas): unknown {
  let color = [0, 0, 0, 255];
  return {
    canvas,
    reset() {
      color = [0, 0, 0, 255];
    },
    set fillStyle(value: string) {
      const match = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(value);
      if (!match) throw new Error(`Unsupported fillStyle ${value}`);
      color = [Number(match[1]), Number(match[2]), Number(match[3]), Math.round(Number(match[4] ?? 1) * 255)];
    },
    fillRect(x: number, y: number, w: number, h: number) {
      for (let py = y; py < Math.min(y + h, canvas.height); py++) {
        for (let px = x; px < Math.min(x + w, canvas.width); px++) {
          canvas.data.set(color, (py * canvas.width + px) * 4);
        }
      }
    },
  };
}

/** A software OffscreenCanvas that supports what the test modules draw: solid rectangles. */
function canvasClass(world: WorldOptions): new (width: number, height: number) => unknown {
  return class {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    private context: unknown = null;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }

    getContext(kind: string): unknown {
      if (kind === 'webgl2' || kind === 'webgl') return world.webgl ? {} : null;
      if (kind !== '2d') return null;
      this.context ??= createContext(this);
      return this.context;
    }

    transferToImageBitmap(): FakeBitmap {
      const bitmap = { width: this.width, height: this.height, data: this.data.slice(), close: () => undefined };
      this.data.fill(0);
      return bitmap;
    }
  };
}

function createWorld(patch: Partial<WorldOptions> = {}) {
  const options: WorldOptions = { webgl: true, silentFrames: false, silentLoad: false, bootFails: false, ...patch };
  const hosts: FakeHost[] = [];
  // Counts close() on bitmaps a test module made itself.
  const strayBitmaps = { closed: 0 };

  const createHost: CreateHost = () => {
    const listeners = new Set<(data: unknown) => void>();
    const workerListeners: ((event: { data: unknown }) => void)[] = [];

    const emit = (data: unknown): void => {
      queueMicrotask(() => {
        if (!host.disposed) for (const listener of [...listeners]) listener(data);
      });
    };

    const runWorker = (code: string): void => {
      const context = vm.createContext({
        postMessage: emit,
        addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => {
          workerListeners.push(listener);
        },
        Worker: () => undefined,
        SharedWorker: () => undefined,
        OffscreenCanvas: canvasClass(options),
        structuredClone,
        closeTracked: () => {
          strayBitmaps.closed++;
        },
      });
      vm.runInContext('globalThis.self = globalThis;', context);
      try {
        vm.runInContext(code, context);
      } catch (error) {
        emit({ type: 'worker-error', message: error instanceof Error ? error.message : String(error) });
      }
    };

    const host: FakeHost = {
      sent: [],
      disposed: false,
      ready: options.bootFails
        ? Promise.reject(new CodeSandboxError('sandbox-failed', 'The background sandbox did not start.'))
        : Promise.resolve(),
      send(message) {
        host.sent.push(message);
        queueMicrotask(() => {
          if (host.disposed) return;
          if (message.type === 'start' && !options.silentLoad) runWorker(message.code);
          if (message.type === 'frame' && !options.silentFrames) {
            for (const listener of workerListeners) listener({ data: message });
          }
        });
      },
      onMessage(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose() {
        host.disposed = true;
      },
    };
    host.ready.catch(() => undefined);
    hosts.push(host);
    return host;
  };

  return { hosts, createHost, options, strayBitmaps };
}

const scene: CodeScene = {
  width: 4,
  height: 3,
  palette: ['#111111', '#eeeeee'],
  frame: { x: 1, y: 1, width: 2, height: 1, radius: 0, border: 0 },
};

function moduleSource(body: string, durationMs = 1000): string {
  return `const meta = { durationMs: ${durationMs} };\n${body}`;
}

const SOLID = (r: string, g = '0', b = '0'): string =>
  `ctx.fillStyle = 'rgb(' + (${r}) + ', ' + (${g}) + ', ' + (${b}) + ')'; ctx.fillRect(0, 0, scene.width, scene.height);`;

function pixel(bitmap: ImageBitmap | null, index = 0): number[] {
  if (!bitmap) throw new Error('Expected a bitmap');
  return [...(bitmap as unknown as FakeBitmap).data.slice(index * 4, index * 4 + 4)];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('frame protocol', () => {
  it('returns back and front bitmaps at the scene size with what the module drew', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    const loaded = await sandbox.load(
      moduleSource(`
function back(ctx, t, scene) { ctx.fillStyle = 'rgb(255, 0, 0)'; ctx.fillRect(0, 0, 2, 2); }
function front(ctx, t, scene) { ctx.fillStyle = 'rgb(0, 0, 255)'; ctx.fillRect(3, 2, 1, 1); }
`),
    );
    expect(loaded.durationMs).toBe(1000);
    const frame = await sandbox.renderFrame(0, scene);
    expect(frame.back).toMatchObject({ width: 4, height: 3 });
    expect(frame.front).toMatchObject({ width: 4, height: 3 });
    expect(pixel(frame.back, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(frame.back, 3)).toEqual([0, 0, 0, 0]);
    expect(pixel(frame.front, 11)).toEqual([0, 0, 255, 255]);
    expect(pixel(frame.front, 0)).toEqual([0, 0, 0, 0]);
    sandbox.dispose();
  });

  it('returns front: null when the module has no front', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await sandbox.load(moduleSource(`function back(ctx, t, scene) { ${SOLID('10')} }`));
    expect((await sandbox.renderFrame(0, scene)).front).toBeNull();
  });

  it('passes t and the scene to the module', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await sandbox.load(
      moduleSource(
        `function back(ctx, t, scene) { ${SOLID('Math.round(t * 100)', 'scene.palette.length', 'scene.frame.x')} }`,
      ),
    );
    const frame = await sandbox.renderFrame(0.5, scene);
    expect(pixel(frame.back)).toEqual([50, 2, 1, 255]);
  });

  it('hands the module a frozen scene', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await sandbox.load(moduleSource(`function back(ctx, t, scene) { scene.frame.x = 5; }`));
    await expect(sandbox.renderFrame(0, scene)).rejects.toMatchObject({ kind: 'module-error' });
  });

  it('rejects a t or a scene size outside the range and a render before load', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await expect(sandbox.renderFrame(0, scene)).rejects.toThrow('Load a module');
    await sandbox.load(moduleSource(`function back(ctx, t, scene) {}`));
    await expect(sandbox.renderFrame(1.5, scene)).rejects.toBeInstanceOf(RangeError);
    await expect(sandbox.renderFrame(Number.NaN, scene)).rejects.toBeInstanceOf(RangeError);
    await expect(sandbox.renderFrame(0, { ...scene, width: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(sandbox.renderFrame(0, { ...scene, height: 1.5 })).rejects.toBeInstanceOf(RangeError);
  });
});

describe('module loading', () => {
  it('accepts export in front of top-level declarations', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    const loaded = await sandbox.load(`export const meta = { durationMs: 2000 };
export function back(ctx, t, scene) {}
export async function helper() {}
export class Thing {}
`);
    expect(loaded.durationMs).toBe(2000);
  });

  it('rejects export default and import with a message that says what to do', async () => {
    const { createHost, hosts } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await expect(sandbox.load('export default { back() {} };')).rejects.toMatchObject({
      kind: 'module-error',
      message: expect.stringContaining('back(ctx, t, scene)') as string,
    });
    await expect(sandbox.load(`import * as x from 'y';\nconst meta = {};`)).rejects.toMatchObject({
      kind: 'module-error',
      message: expect.stringContaining('import is not supported') as string,
    });
    expect(hosts).toHaveLength(0);
  });

  it('reports a syntax error as a module error', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await expect(sandbox.load('const meta = {')).rejects.toMatchObject({ kind: 'module-error' });
  });

  it('names back when it is missing', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await expect(sandbox.load(moduleSource('function front() {}'))).rejects.toMatchObject({
      kind: 'module-error',
      message: expect.stringContaining('back') as string,
    });
  });

  it('rejects a bad meta.durationMs and quotes the value', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await expect(
      sandbox.load(`const meta = { durationMs: "abc" };\nfunction back() {}`),
    ).rejects.toMatchObject({
      kind: 'module-error',
      message: expect.stringContaining('"abc"') as string,
    });
    await expect(sandbox.load(moduleSource('function back() {}', 100))).rejects.toMatchObject({
      kind: 'module-error',
    });
  });

  it('rejects a duration the module forged by posting its own loaded message', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await expect(
      sandbox.load(
        moduleSource(`postMessage({ type: 'loaded', durationMs: Infinity });\nfunction back() {}`),
      ),
    ).rejects.toMatchObject({ kind: 'module-error', message: expect.stringContaining('durationMs') as string });
  });

  it('rejects import statements but not identifiers that start with import', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    for (const line of [`import x from 'y';`, `import { x } from 'y';`, `import('y');`]) {
      await expect(sandbox.load(moduleSource(`${line}\nfunction back() {}`))).rejects.toMatchObject({
        kind: 'module-error',
      });
    }
    await expect(
      sandbox.load(
        moduleSource(`let importance = 0;\nconst imported = [];\nimportance = 2;\nimported.push(importance);\nfunction back() {}`),
      ),
    ).resolves.toEqual({ durationMs: 1000 });
  });

  it('removes Worker before the module runs', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await sandbox.load(
      moduleSource(`const hadWorker = typeof Worker !== 'undefined' || typeof SharedWorker !== 'undefined';
function back(ctx, t, scene) { ${SOLID('hadWorker ? 255 : 0', 'hadWorker ? 0 : 255')} }`),
    );
    expect(pixel((await sandbox.renderFrame(0, scene)).back)).toEqual([0, 255, 0, 255]);
  });

  it('refuses an oversize source without creating a host', async () => {
    const { createHost, hosts } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await expect(sandbox.load(`// ${'x'.repeat(MAX_SOURCE_BYTES)}`)).rejects.toMatchObject({
      kind: 'source-too-large',
    });
    expect(hosts).toHaveLength(0);
  });
});

describe('errors while rendering', () => {
  it('truncates a thrown message, keeps the host and renders the next frame', async () => {
    const { createHost, hosts } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await sandbox.load(
      moduleSource(`function back(ctx, t, scene) {
  if (t > 0.5) throw new Error('x'.repeat(2000));
  ${SOLID('7')}
}`),
    );
    const failure = (await sandbox.renderFrame(0.9, scene).catch((error: unknown) => error)) as CodeSandboxError;
    expect(failure).toBeInstanceOf(CodeSandboxError);
    expect(failure.kind).toBe('module-error');
    expect(failure.message.startsWith('Error: ')).toBe(true);
    expect(failure.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS + 1);
    expect((await sandbox.renderFrame(0.2, scene)).back).not.toBeNull();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.disposed).toBe(false);
  });

  it('rejects a frame whose canvas the module resized and recovers on the next frame', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await sandbox.load(
      moduleSource(`function back(ctx, t, scene) { if (t > 0.5) ctx.canvas.width = 2; ${SOLID('5')} }`),
    );
    await expect(sandbox.renderFrame(0.9, scene)).rejects.toMatchObject({
      kind: 'module-error',
      message: expect.stringContaining('resize') as string,
    });
    expect(await sandbox.renderFrame(0.1, scene)).toMatchObject({ back: { width: 4, height: 3 } });
  });

  it('closes bitmaps from messages it did not ask for', async () => {
    const { createHost, strayBitmaps } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await sandbox.load(
      moduleSource(`function back(ctx, t, scene) {
  for (let i = 0; i < 3; i++) {
    const bitmap = { width: 1, height: 1, close: closeTracked };
    postMessage({ type: 'frame', id: 999, back: bitmap, front: bitmap });
  }
  ${SOLID('3')}
}`),
    );
    expect(pixel((await sandbox.renderFrame(0, scene)).back)).toEqual([3, 0, 0, 255]);
    await Promise.resolve();
    expect(strayBitmaps.closed).toBe(6);
  });

  it('recreates the sandbox when the module floods it with messages', async () => {
    const { createHost, hosts } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await sandbox.load(
      moduleSource(`function back(ctx, t, scene) {
  if (t > 0.5) for (let i = 0; i < 40; i++) postMessage({ type: 'noise' });
  ${SOLID('4')}
}`),
    );
    await expect(sandbox.renderFrame(0.9, scene)).rejects.toMatchObject({ kind: 'sandbox-failed' });
    expect(hosts[0]?.disposed).toBe(true);
    expect(pixel((await sandbox.renderFrame(0.1, scene)).back)).toEqual([4, 0, 0, 255]);
    expect(hosts).toHaveLength(2);
  });

  it('rejects a Promise returned from back', async () => {
    const { createHost } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await sandbox.load(moduleSource('function back() { return Promise.resolve(); }'));
    await expect(sandbox.renderFrame(0, scene)).rejects.toMatchObject({
      kind: 'module-error',
      message: expect.stringContaining('synchronously') as string,
    });
  });
});

describe('timeouts and boot failures', () => {
  it('kills the host on a frame timeout and starts a new one for the next frame', async () => {
    vi.useFakeTimers();
    const { createHost, hosts, options } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await sandbox.load(moduleSource(`function back(ctx, t, scene) { ${SOLID('1')} }`));
    await sandbox.renderFrame(0, scene);

    options.silentFrames = true;
    const slow = sandbox.renderFrame(0.5, scene);
    const slowResult = expect(slow).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(250);
    await slowResult;
    expect(hosts[0]?.disposed).toBe(true);

    const next = sandbox.renderFrame(0.1, scene);
    const nextResult = expect(next).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(3000);
    await nextResult;
    expect(hosts).toHaveLength(2);
    expect(hosts[1]?.sent.map((m) => m.type)).toEqual(['start', 'frame']);
  });

  it('gives the first frame after a load the load limit', async () => {
    vi.useFakeTimers();
    const { createHost } = createWorld({ silentFrames: true });
    const sandbox = createCodeSandbox({ createHost });
    await sandbox.load(moduleSource(`function back(ctx, t, scene) { ${SOLID('1')} }`));

    let settled = false;
    const first = sandbox.renderFrame(0, scene);
    const firstResult = expect(first).rejects.toMatchObject({ kind: 'timeout' });
    void first.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2750);
    await firstResult;
  });

  it('times out a module that never finishes loading', async () => {
    vi.useFakeTimers();
    const { createHost, hosts } = createWorld({ silentLoad: true });
    const sandbox = createCodeSandbox({ createHost });
    const loading = expect(sandbox.load(moduleSource('function back() {}'))).rejects.toMatchObject({
      kind: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(3000);
    await loading;
    expect(hosts[0]?.disposed).toBe(true);
  });

  it('maps a worker that could not be created to sandbox-failed', async () => {
    let listen: (data: unknown) => void = () => undefined;
    const host: SandboxHost = {
      ready: Promise.resolve(),
      send: (message) => {
        if (message.type === 'start') {
          queueMicrotask(() => {
            listen({ type: 'boot-error', message: 'SecurityError' });
          });
        }
      },
      onMessage: (listener) => {
        listen = listener;
        return () => undefined;
      },
      dispose: () => undefined,
    };
    const sandbox = createCodeSandbox({ createHost: () => host });
    await expect(sandbox.load(moduleSource('function back() {}'))).rejects.toMatchObject({
      kind: 'sandbox-failed',
      message: expect.stringContaining('SecurityError') as string,
    });
  });

  it('reports a sandbox that did not boot', async () => {
    const { createHost, hosts } = createWorld({ bootFails: true });
    const sandbox = createCodeSandbox({ createHost });
    await expect(sandbox.load(moduleSource('function back() {}'))).rejects.toMatchObject({
      kind: 'sandbox-failed',
    });
    expect(hosts[0]?.disposed).toBe(true);
  });
});

describe('three.js', () => {
  const threeModule = moduleSource(`function back(ctx, t, scene) { ${SOLID('THREE.ok ? 9 : 1')} }`);

  it('fails with no-webgl when WebGL is missing', async () => {
    const { createHost } = createWorld({ webgl: false });
    const sandbox = createCodeSandbox({ createHost, loadThree: () => Promise.resolve('var THREE = { ok: true };') });
    await expect(sandbox.load(threeModule)).rejects.toMatchObject({ kind: 'no-webgl' });
  });

  it('exposes THREE to the module when WebGL is present', async () => {
    const { createHost } = createWorld({ webgl: true });
    const sandbox = createCodeSandbox({ createHost, loadThree: () => Promise.resolve('var THREE = { ok: true };') });
    await sandbox.load(threeModule);
    expect(pixel((await sandbox.renderFrame(0, scene)).back)).toEqual([9, 0, 0, 255]);
  });

  it('loads three for bracket access too', async () => {
    const { createHost } = createWorld({ webgl: false });
    const loadThree = vi.fn(() => Promise.resolve('var THREE = {};'));
    const sandbox = createCodeSandbox({ createHost, loadThree });
    await expect(sandbox.load(moduleSource("function back() { return THREE['Scene']; }"))).rejects.toMatchObject({
      kind: 'no-webgl',
    });
    expect(loadThree).toHaveBeenCalledOnce();
  });

  it('does not load three for a source that does not mention it', async () => {
    const { createHost } = createWorld({ webgl: false });
    const loadThree = vi.fn(() => Promise.resolve(''));
    const sandbox = createCodeSandbox({ createHost, loadThree });
    await sandbox.load(moduleSource('// no THREE here\nfunction back() {}'));
    expect(loadThree).not.toHaveBeenCalled();
  });
});

describe('dispose', () => {
  it('rejects later calls with disposed and disposes the host', async () => {
    const { createHost, hosts } = createWorld();
    const sandbox = createCodeSandbox({ createHost });
    await sandbox.load(moduleSource('function back() {}'));
    sandbox.dispose();
    sandbox.dispose();
    expect(hosts[0]?.disposed).toBe(true);
    await expect(sandbox.renderFrame(0, scene)).rejects.toMatchObject({ kind: 'disposed' });
    await expect(sandbox.load(moduleSource('function back() {}'))).rejects.toMatchObject({ kind: 'disposed' });
  });
});

describe('checkModule', () => {
  const readPixels = (bitmap: ImageBitmap): Uint8ClampedArray => (bitmap as unknown as FakeBitmap).data;

  it('reports a looping module', async () => {
    const { createHost } = createWorld();
    const result = await checkModule(
      moduleSource(`function back(ctx, t, scene) { ${SOLID('Math.round(127.5 + 127 * Math.sin(2 * Math.PI * t))')} }`),
      scene,
      { sandbox: { createHost }, readPixels },
    );
    expect(result).toMatchObject({ ok: true, loops: true, durationMs: 1000 });
  });

  it('reports a module whose last frame differs from its first', async () => {
    const { createHost } = createWorld();
    const result = await checkModule(
      moduleSource(`function back(ctx, t, scene) { ${SOLID('Math.round(t * 255)')} }`),
      scene,
      { sandbox: { createHost }, readPixels },
    );
    expect(result).toMatchObject({ ok: true, loops: false });
  });

  it('turns a module error into a failed check and always disposes the sandbox', async () => {
    const { createHost, hosts } = createWorld();
    const result = await checkModule(moduleSource(`function back() { throw new Error('boom'); }`), scene, {
      sandbox: { createHost },
      readPixels,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('module-error');
    expect(result.error?.message).toContain('boom');
    expect(hosts[0]?.disposed).toBe(true);
  });

  it('disposes the sandbox as soon as the signal aborts, even in the middle of a frame', async () => {
    const { createHost, hosts } = createWorld({ silentFrames: true });
    const abort = new AbortController();
    const pending = checkModule(moduleSource('function back(ctx, t, scene) {}'), scene, {
      sandbox: { createHost, frameTimeoutMs: 60_000 },
      readPixels,
      signal: abort.signal,
    });
    await vi.waitFor(() => { expect(hosts[0]?.sent.some((m) => m.type === 'frame')).toBe(true); });
    abort.abort();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'disposed' } });
    expect(hosts[0]?.disposed).toBe(true);
  });

  it('does not start work for a signal that is already aborted', async () => {
    const { createHost, hosts } = createWorld();
    const result = await checkModule(moduleSource('function back(ctx, t, scene) {}'), scene, {
      sandbox: { createHost },
      readPixels,
      signal: AbortSignal.abort(),
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'disposed' } });
    expect(hosts).toHaveLength(0);
  });

  it('measures the slowest frame with the injected clock', async () => {
    const { createHost } = createWorld();
    let tick = 0;
    const durations = [3, 40, 5];
    const result = await checkModule(moduleSource(`function back(ctx, t, scene) { ${SOLID('1')} }`), scene, {
      samples: 2,
      sandbox: { createHost },
      readPixels,
      now: () => {
        const call = tick++;
        if (call % 2 === 0) return call * 1000;
        return (call - 1) * 1000 + (durations[(call - 1) / 2] ?? 0);
      },
    });
    expect(result.maxFrameMs).toBe(40);
  });
});

describe('createSandboxFrameSource', () => {
  it('loads a module and renders t=0 at the scene size with the scene it was given', async () => {
    const { createHost } = createWorld();
    const source = createSandboxFrameSource({ createHost });
    await source.load(
      moduleSource(`function back(ctx, t, scene) { ${SOLID('scene.palette.length', 'scene.frame.width', 'scene.frame.height')} }`),
    );
    const frame = await source.renderFrame(0, scene);
    expect(frame.back).toMatchObject({ width: scene.width, height: scene.height });
    expect(pixel(frame.back)).toEqual([2, 2, 1, 255]);
    expect(frame.front).toBeNull();
    source.dispose();
  });

  it('reports a module error from load and from a frame', async () => {
    const { createHost } = createWorld();
    const source = createSandboxFrameSource({ createHost });
    await expect(source.load('const meta = {')).rejects.toMatchObject({ kind: 'module-error' });
    await source.load(moduleSource('function back(ctx, t, scene) { missing.call(); }'));
    await expect(source.renderFrame(0, scene)).rejects.toMatchObject({ kind: 'module-error' });
    source.dispose();
  });
});

describe('framesMatch', () => {
  const a = new Uint8ClampedArray([10, 10, 10, 255, 0, 0, 0, 0]);

  it('allows a difference up to the channel tolerance and not beyond', () => {
    expect(framesMatch(a, new Uint8ClampedArray([18, 10, 10, 255, 0, 0, 0, 0]), 8, 0)).toBe(true);
    expect(framesMatch(a, new Uint8ClampedArray([19, 10, 10, 255, 0, 0, 0, 0]), 8, 0)).toBe(false);
  });

  it('allows mismatched pixels up to the ratio and not beyond', () => {
    const different = new Uint8ClampedArray([200, 10, 10, 255, 0, 0, 0, 0]);
    expect(framesMatch(a, different, 8, 0.5)).toBe(true);
    expect(framesMatch(a, different, 8, 0.49)).toBe(false);
  });

  it('does not match arrays of different lengths', () => {
    expect(framesMatch(a, new Uint8ClampedArray(4), 8, 1)).toBe(false);
  });
});

describe('content security policy', () => {
  it('keeps the bootstrap hash in step with the script, the sandbox document and tauri.conf.json', () => {
    const hash = `'sha256-${createHash('sha256').update(BOOTSTRAP_SCRIPT, 'utf8').digest('base64')}'`;
    expect(BOOTSTRAP_CSP_HASH).toBe(hash);
    expect(sandboxDocument()).toContain(hash);

    const config = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'),
    ) as { app: { security: { csp: Record<string, string> } } };
    const scriptSrc = config.app.security.csp['script-src'] ?? '';
    expect(scriptSrc.match(/'sha256-[^']+'/g)).toEqual([hash]);
    expect(config.app.security.csp['worker-src']).toBe('blob:');
  });
});

describe('createIframeHost', () => {
  function fakeDocument() {
    const contentWindow = { postMessage: vi.fn() };
    const iframe = {
      attributes: new Map<string, string>(),
      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      },
      style: { cssText: '' },
      tabIndex: 0,
      srcdoc: '',
      contentWindow,
      remove: vi.fn(),
    };
    const messageListeners = new Set<(event: { source: unknown; data: unknown }) => void>();
    const removeEventListener = vi.fn((_type: string, listener: (event: { source: unknown; data: unknown }) => void) => {
      messageListeners.delete(listener);
    });
    const win = {
      addEventListener: (_type: string, listener: (event: { source: unknown; data: unknown }) => void) => {
        messageListeners.add(listener);
      },
      removeEventListener,
    };
    const doc = { defaultView: win, createElement: () => iframe, body: { append: vi.fn() } } as unknown as Document;
    const dispatch = (source: unknown, data: unknown): void => {
      for (const listener of [...messageListeners]) listener({ source, data });
    };
    return { doc, iframe, contentWindow, dispatch, removeEventListener, messageListeners };
  }

  it('creates an opaque-origin iframe and only listens to its own window', () => {
    const { doc, iframe, contentWindow, dispatch } = fakeDocument();
    const host = createIframeHost({ doc });
    expect(iframe.attributes.get('sandbox')).toBe('allow-scripts');
    expect(iframe.srcdoc).toBe(sandboxDocument());

    const received: unknown[] = [];
    host.onMessage((data) => received.push(data));
    dispatch({}, { type: 'frame', id: 1 });
    dispatch(contentWindow, { type: 'frame', id: 2 });
    expect(received).toEqual([{ type: 'frame', id: 2 }]);
    host.dispose();
  });

  it('resolves ready on boot-ready from the iframe and ignores one from elsewhere', async () => {
    vi.useFakeTimers();
    const { doc, contentWindow, dispatch } = fakeDocument();
    const host = createIframeHost({ doc });
    let resolved = false;
    void host.ready.then(() => {
      resolved = true;
    });
    dispatch({}, { type: 'boot-ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    dispatch(contentWindow, { type: 'boot-ready' });
    await host.ready;
    host.dispose();
  });

  it('rejects ready with sandbox-failed after the boot timeout', async () => {
    vi.useFakeTimers();
    const { doc } = fakeDocument();
    const host = createIframeHost({ doc, bootTimeoutMs: 1000 });
    const result = expect(host.ready).rejects.toMatchObject({ kind: 'sandbox-failed' });
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    host.dispose();
  });

  it('sends terminate, removes the listener and the iframe on dispose, once', () => {
    const { doc, iframe, contentWindow, removeEventListener, messageListeners } = fakeDocument();
    const host = createIframeHost({ doc });
    host.dispose();
    host.dispose();
    expect(contentWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(contentWindow.postMessage).toHaveBeenCalledWith({ type: 'terminate' }, '*');
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(messageListeners.size).toBe(0);
    expect(iframe.remove).toHaveBeenCalledTimes(1);
  });
});
