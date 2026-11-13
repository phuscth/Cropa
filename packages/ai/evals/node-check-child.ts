// The checker itself: it runs inside the child process `node-check.ts` starts under the Node
// permission model, reads one request from stdin and sends one result over the IPC channel.
// It loads an AI-written background module in a vm context the way the desktop sandbox does,
// using the real sandbox worker runtime and wrapper.
//
// The context is the barrier against hostile model code, so nothing from this realm goes into
// it: it is created with string code generation switched off, every shim (canvas, WebGL stub,
// postMessage, ...) and three.js itself are evaluated inside it, and the host talks to it only
// by running source text that returns strings.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Taken before any model code exists, and never put into the context.
const send = process.send?.bind(process);
// A rejected promise made by model code (a refused dynamic import) must not end this process.
process.on('unhandledRejection', () => undefined);

const runtime = readFileSync(
  new URL('../../../apps/desktop/src/features/code-sandbox/worker-runtime.js', import.meta.url),
  'utf8',
);
const shims = readFileSync(new URL('./node-check-shims.js', import.meta.url), 'utf8');

type Op = unknown[];
type Message = Record<string, unknown>;

interface Bitmap {
  width: number;
  height: number;
  ops: Op[];
}

interface Frame {
  back: Op[] | null;
  front: Op[] | null;
}

const KINDS: readonly string[] = ['timeout', 'source-too-large', 'module-error', 'no-webgl', 'sandbox-failed', 'disposed'];

function moduleError(error: unknown): CodeSandboxError {
  const info = typeof error === 'object' && error !== null ? (error as Message) : null;
  const kind = typeof info?.['kind'] === 'string' && KINDS.includes(info['kind']) ? info['kind'] : 'module-error';
  const message = typeof info?.['message'] === 'string' ? info['message'] : 'The module failed without a message.';
  return new CodeSandboxError(kind as CodeSandboxErrorKind, truncateMessage(message));
}

function timedOut(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
}

function reasonOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unknown error';
  }
}

/**
 * three.js evaluated inside `context`: its own source, linked from the package directory, so
 * every THREE function has the context's Function as its constructor.
 */
async function loadThree(context: vm.Context): Promise<object> {
  const entry = fileURLToPath(import.meta.resolve('three'));
  const modules = new Map<string, vm.SourceTextModule>();
  const open = (file: string): vm.SourceTextModule => {
    let module = modules.get(file);
    if (!module) {
      module = new vm.SourceTextModule(readFileSync(file, 'utf8'), { context, identifier: file });
      modules.set(file, module);
    }
    return module;
  };
  const root = open(entry);
  await root.link((specifier, referencing) => {
    if (!specifier.startsWith('./')) throw new Error(`Unexpected import ${specifier} in three`);
    return Promise.resolve(open(resolve(dirname(referencing.identifier), specifier)));
  });
  await root.evaluate();
  return root.namespace;
}

async function check(
  source: string,
  scene: NodeScene,
  options: ResolvedNodeCheckOptions,
  progress: { maxFrameMs: number },
): Promise<NodeCheck> {
  const { samples, frameTimeoutMs, loadTimeoutMs } = options;
  const bytes = sourceBytes(source);
  if (bytes > MAX_SOURCE_BYTES) {
    throw new CodeSandboxError(
      'source-too-large',
      `The source is ${String(bytes)} bytes; the limit is ${String(MAX_SOURCE_BYTES)} bytes. Write a shorter module.`,
    );
  }

  const code = composeWorkerSource(runtime, source, null);
  const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(shims, context);
  vm.runInContext('globalThis.self = globalThis;', context);
  if (usesThree(source)) {
    // Handed over through a global that is removed before any model code runs.
    sandbox['__three'] = await loadThree(context);
    vm.runInContext('__cropaDriver.useThree(__three); delete globalThis.__three;', context);
  }

  try {
    vm.runInContext(code, context, { timeout: loadTimeoutMs });
  } catch (error) {
    if (timedOut(error)) {
      throw new CodeSandboxError(
        'timeout',
        `The module did not finish loading within ${String(loadTimeoutMs)} ms. Remove loops that run at the top level.`,
      );
    }
    throw new CodeSandboxError('module-error', truncateMessage(`The module could not run: ${reasonOf(error)}`));
  }

  const loaded = JSON.parse(String(vm.runInContext('__cropaDriver.loaded()', context))) as Message | null;
  if (loaded === null) throw new CodeSandboxError('module-error', 'The module did not finish loading.');
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
  const sceneJson = JSON.stringify(scene);
  const renderAt = (t: number): Frame => {
    const id = nextId++;
    const limitMs = first ? Math.max(frameTimeoutMs, loadTimeoutMs) : frameTimeoutMs;
    first = false;
    const timeout = () =>
      new CodeSandboxError(
        'timeout',
        `Rendering the frame at t=${String(t)} took longer than ${String(limitMs)} ms. Make back and front cheaper: fewer shapes, no loops that run long.`,
      );
    const call = `__cropaDriver.frame(${String(id)}, ${String(t)}, ${JSON.stringify(sceneJson)})`;
    const started = performance.now();
    let json: string;
    try {
      json = String(vm.runInContext(call, context, { timeout: limitMs }));
    } catch (error) {
      if (timedOut(error)) throw timeout();
      throw new CodeSandboxError('module-error', truncateMessage(`The module could not run: ${reasonOf(error)}`));
    }
    const elapsed = performance.now() - started;
    progress.maxFrameMs = Math.max(progress.maxFrameMs, elapsed);
    if (elapsed > limitMs) throw timeout();

    const reply = JSON.parse(json) as (Message & { back?: Bitmap | null; front?: Bitmap | null }) | null;
    if (reply === null) throw new CodeSandboxError('module-error', 'The module did not return a frame.');
    if (typeof reply['threw'] === 'string') {
      throw new CodeSandboxError('module-error', truncateMessage(`The module could not run: ${reply['threw']}`));
    }
    if (reply['error'] !== undefined) throw moduleError(reply['error']);
    const { back, front } = reply;
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
  return { ok: true, loops, maxFrameMs: progress.maxFrameMs, durationMs };
}

interface Request {
  nonce: string;
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
const progress = { maxFrameMs: 0 };
let result: NodeCheck;
try {
  result = await check(request.source, request.scene, request.options, progress);
} catch (error) {
  if (!(error instanceof CodeSandboxError)) throw error;
  result = {
    ok: false,
    error: { kind: error.kind, message: error.message },
    loops: false,
    maxFrameMs: progress.maxFrameMs,
  };
}
// The result goes out on the IPC channel with the nonce the parent chose; stdout is not read.
send?.({ nonce: request.nonce, result }, () => { process.exit(0); });
