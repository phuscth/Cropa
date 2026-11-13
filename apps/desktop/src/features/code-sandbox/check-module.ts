import { CodeSandboxError, type CodeSandboxErrorKind } from './errors.ts';
import { createCodeSandbox, type CodeFrame, type CodeSandboxOptions, type CodeScene } from './sandbox.ts';

export interface ModuleCheck {
  ok: boolean;
  error?: { kind: CodeSandboxErrorKind; message: string };
  loops: boolean;
  maxFrameMs: number;
  durationMs?: number;
}

export interface CheckModuleOptions {
  samples?: number;
  channelTolerance?: number;
  maxMismatchRatio?: number;
  sandbox?: CodeSandboxOptions;
  readPixels?: (bitmap: ImageBitmap) => Uint8ClampedArray;
  now?: () => number;
  /** Aborting disposes the sandbox at once; the check then ends with a `disposed` error. */
  signal?: AbortSignal;
}

/** True when at most `maxMismatchRatio` of the pixels differ by more than `channelTolerance` in any channel. */
export function framesMatch(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  channelTolerance: number,
  maxMismatchRatio: number,
): boolean {
  if (a.length !== b.length) return false;
  const pixels = a.length / 4;
  let mismatched = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0)) > channelTolerance) {
        mismatched++;
        break;
      }
    }
  }
  return mismatched <= maxMismatchRatio * pixels;
}

function readWithCanvas(bitmap: ImageBitmap): Uint8ClampedArray {
  const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
  if (!ctx) throw new Error('A 2D canvas is not available to read the frame');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

interface Pixels {
  back: Uint8ClampedArray | null;
  front: Uint8ClampedArray | null;
}

/** Renders the module over one loop and reports whether it errors, loops cleanly and how slow a frame is. */
export async function checkModule(
  source: string,
  scene: CodeScene,
  options: CheckModuleOptions = {},
): Promise<ModuleCheck> {
  const samples = options.samples ?? 12;
  const channelTolerance = options.channelTolerance ?? 8;
  const maxMismatchRatio = options.maxMismatchRatio ?? 0.001;
  const readPixels = options.readPixels ?? readWithCanvas;
  const now = options.now ?? (() => performance.now());

  const sandbox = createCodeSandbox(options.sandbox);
  let maxFrameMs = 0;
  const { signal } = options;
  const onAbort = (): void => { sandbox.dispose(); };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  function take(frame: CodeFrame): Pixels {
    try {
      return {
        back: frame.back ? readPixels(frame.back) : null,
        front: frame.front ? readPixels(frame.front) : null,
      };
    } finally {
      frame.back?.close();
      frame.front?.close();
    }
  }

  async function renderAt(t: number): Promise<Pixels> {
    const started = now();
    const frame = await sandbox.renderFrame(t, scene);
    maxFrameMs = Math.max(maxFrameMs, now() - started);
    return take(frame);
  }

  function same(a: Uint8ClampedArray | null, b: Uint8ClampedArray | null): boolean {
    if (a === null || b === null) return a === b;
    return framesMatch(a, b, channelTolerance, maxMismatchRatio);
  }

  try {
    const { durationMs } = await sandbox.load(source);
    let first: Pixels | null = null;
    for (let k = 0; k < samples; k++) {
      const pixels = await renderAt(k / samples);
      if (k === 0) first = pixels;
    }
    const last = await renderAt(1);
    const loops = first !== null && same(first.back, last.back) && same(first.front, last.front);
    return { ok: true, loops, maxFrameMs, durationMs };
  } catch (error) {
    if (error instanceof CodeSandboxError) {
      return { ok: false, error: { kind: error.kind, message: error.message }, loops: false, maxFrameMs };
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    sandbox.dispose();
  }
}
