import { CodeSandboxError, truncateMessage, type CodeSandboxErrorKind } from './errors.ts';
import { createIframeHost, type CreateHost, type SandboxHost } from './host.ts';
import { loadThreeSource } from './three-source.ts';
import { buildWorkerSource, MAX_SOURCE_BYTES, sourceBytes, usesThree } from './worker-source.ts';

export interface CodeScene {
  width: number;
  height: number;
  palette: string[];
  frame: { x: number; y: number; width: number; height: number; radius: number; border: number };
}

export interface CodeFrame {
  back: ImageBitmap | null;
  front: ImageBitmap | null;
}

export interface CodeSandbox {
  load(source: string): Promise<{ durationMs: number }>;
  renderFrame(t: number, scene: CodeScene): Promise<CodeFrame>;
  dispose(): void;
}

export interface CodeSandboxOptions {
  frameTimeoutMs?: number;
  loadTimeoutMs?: number;
  createHost?: CreateHost;
  loadThree?: () => Promise<string>;
}

export const DEFAULT_FRAME_TIMEOUT_MS = 250;
const DEFAULT_LOAD_TIMEOUT_MS = 3000;
const MAX_CANVAS_SIDE = 16384;

const ERROR_KINDS: readonly string[] = [
  'timeout',
  'source-too-large',
  'module-error',
  'no-webgl',
  'sandbox-failed',
  'disposed',
] satisfies CodeSandboxErrorKind[];

type Message = Record<string, unknown>;

function asMessage(data: unknown): Message | null {
  return typeof data === 'object' && data !== null ? (data as Message) : null;
}

function isBitmapLike(value: unknown): value is ImageBitmap {
  if (typeof value !== 'object' || value === null) return false;
  const bitmap = value as Record<string, unknown>;
  return (
    typeof bitmap['width'] === 'number' &&
    typeof bitmap['height'] === 'number' &&
    typeof bitmap['close'] === 'function'
  );
}

function closeBitmap(value: unknown): void {
  if (isBitmapLike(value)) value.close();
}

function moduleError(error: unknown): CodeSandboxError {
  const info = asMessage(error);
  const kind = typeof info?.['kind'] === 'string' && ERROR_KINDS.includes(info['kind']) ? info['kind'] : 'module-error';
  const message = typeof info?.['message'] === 'string' ? info['message'] : 'The module failed without a message.';
  return new CodeSandboxError(kind as CodeSandboxErrorKind, truncateMessage(message));
}

function workerError(data: Message): CodeSandboxError {
  const message = typeof data['message'] === 'string' && data['message'] !== '' ? data['message'] : 'unknown error';
  return new CodeSandboxError('module-error', truncateMessage(`The module could not run: ${message}`));
}

export function createCodeSandbox(options: CodeSandboxOptions = {}): CodeSandbox {
  const frameTimeoutMs = options.frameTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const createHost = options.createHost ?? (() => createIframeHost());
  const loadThree = options.loadThree ?? loadThreeSource;

  let host: SandboxHost | null = null;
  let loaded: { source: string; durationMs: number } | null = null;
  let needsReload = false;
  // The first frame after a load can compile shaders, so it gets the longer load limit.
  let freshHost = false;
  let disposed = false;
  let nextId = 0;
  let chain: Promise<unknown> = Promise.resolve();

  let rejectDisposed: (error: Error) => void = () => undefined;
  const disposedSignal = new Promise<never>((_, reject) => {
    rejectDisposed = reject;
  });
  disposedSignal.catch(() => undefined);

  const disposedError = (): CodeSandboxError => new CodeSandboxError('disposed', 'The code sandbox was disposed.');

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(() => {
      if (disposed) throw disposedError();
      return task();
    });
    chain = run.catch(() => undefined);
    return run;
  }

  function dropHost(): void {
    host?.dispose();
    host = null;
  }

  /** Resolves with the first message `pick` accepts; a timeout or a dispose ends the wait. */
  async function waitFor<T>(
    current: SandboxHost,
    pick: (data: Message) => T | undefined,
    timeoutMs: number,
    onTimeout: () => Error,
  ): Promise<T> {
    let off = (): void => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = new Promise<T>((resolve, reject) => {
      off = current.onMessage((data) => {
        const message = asMessage(data);
        const picked = message ? pick(message) : undefined;
        if (picked !== undefined) resolve(picked);
      });
      timer = setTimeout(() => {
        reject(onTimeout());
      }, timeoutMs);
    });
    try {
      return await Promise.race([reply, disposedSignal]);
    } finally {
      clearTimeout(timer);
      off();
    }
  }

  async function startHost(source: string): Promise<number> {
    const code = buildWorkerSource(source, usesThree(source) ? await loadThree() : null);
    if (disposed) throw disposedError();
    dropHost();
    const current = createHost();
    host = current;
    try {
      try {
        await Promise.race([current.ready, disposedSignal]);
      } catch (error) {
        if (error instanceof CodeSandboxError) throw error;
        throw new CodeSandboxError('sandbox-failed', 'The background sandbox did not start.');
      }
      const answer = waitFor<Message>(
        current,
        (data) =>
          data['type'] === 'loaded' || data['type'] === 'worker-error' || data['type'] === 'boot-error'
            ? data
            : undefined,
        loadTimeoutMs,
        () =>
          new CodeSandboxError(
            'timeout',
            `The module did not finish loading within ${loadTimeoutMs} ms. Remove loops that run at the top level.`,
          ),
      );
      current.send({ type: 'start', code });
      const result = await answer;
      if (result['type'] === 'boot-error') {
        const reason = typeof result['message'] === 'string' ? result['message'] : 'unknown error';
        throw new CodeSandboxError('sandbox-failed', truncateMessage(`The background sandbox could not start its worker: ${reason}`));
      }
      if (result['type'] === 'worker-error') throw workerError(result);
      if (result['error'] !== undefined) throw moduleError(result['error']);
      // The module shares the worker global and can post its own `loaded`, so the duration is checked here too.
      const durationMs = result['durationMs'];
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 250 || durationMs > 60000) {
        throw new CodeSandboxError(
          'module-error',
          `meta.durationMs must be a number of milliseconds from 250 to 60000, got ${JSON.stringify(durationMs)}.`,
        );
      }
      freshHost = true;
      return durationMs;
    } catch (error) {
      if (host === current) dropHost();
      else current.dispose();
      throw error;
    }
  }

  async function renderOnce(t: number, scene: CodeScene): Promise<CodeFrame> {
    if (loaded === null) throw new Error('Load a module before rendering a frame');
    if (needsReload || host === null) {
      await startHost(loaded.source);
      needsReload = false;
    }
    const current = host;
    if (current === null) throw disposedError();
    const id = nextId++;
    const limitMs = freshHost ? Math.max(frameTimeoutMs, loadTimeoutMs) : frameTimeoutMs;
    freshHost = false;
    const sceneCopy = structuredClone(scene);
    const answer = waitFor<Message>(
      current,
      (data) => {
        if (data['type'] === 'worker-error') return data;
        return data['type'] === 'frame' && data['id'] === id ? data : undefined;
      },
      limitMs,
      () =>
        new CodeSandboxError(
          'timeout',
          `Rendering the frame at t=${t} took longer than ${limitMs} ms. Make back and front cheaper: fewer shapes, no loops that run long.`,
        ),
    );
    current.send({ type: 'frame', id, t, scene: sceneCopy });
    let reply: Message;
    try {
      reply = await answer;
    } catch (error) {
      if (error instanceof CodeSandboxError && error.kind === 'timeout') {
        dropHost();
        needsReload = true;
      }
      throw error;
    }
    if (reply['type'] === 'worker-error') throw workerError(reply);
    if (reply['error'] !== undefined) throw moduleError(reply['error']);
    const { back, front } = reply;
    if (!isBitmapLike(back) || (front !== null && !isBitmapLike(front))) {
      closeBitmap(back);
      closeBitmap(front);
      throw new CodeSandboxError(
        'module-error',
        'The sandbox returned a frame without bitmaps. back must draw on ctx and front is optional.',
      );
    }
    for (const bitmap of [back, front]) {
      if (bitmap !== null && (bitmap.width !== scene.width || bitmap.height !== scene.height)) {
        closeBitmap(back);
        closeBitmap(front);
        throw new CodeSandboxError(
          'module-error',
          `The frame is ${bitmap.width}x${bitmap.height} but the scene is ${scene.width}x${scene.height}. Do not resize ctx.canvas.`,
        );
      }
    }
    return { back, front };
  }

  return {
    load(source) {
      return serialize(async () => {
        const bytes = sourceBytes(source);
        if (bytes > MAX_SOURCE_BYTES) {
          throw new CodeSandboxError(
            'source-too-large',
            `The source is ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES} bytes. Write a shorter module.`,
          );
        }
        const durationMs = await startHost(source);
        loaded = { source, durationMs };
        needsReload = false;
        return { durationMs };
      });
    },

    renderFrame(t, scene) {
      return serialize(() => {
        if (!Number.isFinite(t) || t < 0 || t > 1) {
          throw new RangeError(`t must be a number from 0 to 1, got ${t}`);
        }
        for (const side of [scene.width, scene.height]) {
          if (!Number.isInteger(side) || side < 1 || side > MAX_CANVAS_SIDE) {
            throw new RangeError(`scene width and height must be integers from 1 to ${MAX_CANVAS_SIDE}, got ${side}`);
          }
        }
        return renderOnce(t, scene);
      });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      dropHost();
      rejectDisposed(disposedError());
    },
  };
}
