// Checks AI-written background modules in Node, the way the desktop sandbox does, so the eval
// can tell whether an answer would load, draw within the time limit and loop.
//
// The module is model output, so it never runs in this process. Each check starts a child Node
// process under the permission model (`--permission`): it may read only the files the checker
// needs, and it may not write files, spawn processes, start workers or load addons. Its
// environment is empty. The source goes in on stdin, the result comes back over an IPC channel
// with a per-run nonce, and the child is killed on a wall-clock limit.
//
// Inside the child the module runs in a vm context that gets no host object at all: string code
// generation is off, and the canvas and WebGL shims, postMessage and three.js are all evaluated
// inside the context (see node-check-child.ts), so no function the module can reach leads back
// to `process`.
//
// The network is NOT blocked by the process. Node 24's permission model has no network flag (a
// deny-by-default `--allow-net` only exists in later releases, and the repo supports Node >=22.18
// and runs CI on 24), so a socket opened by code that escaped the context would connect. The
// in-context isolation above is the barrier, not the process.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { CodeSandboxErrorKind } from '../../../apps/desktop/src/features/code-sandbox/errors.ts';

export interface NodeScene {
  width: number;
  height: number;
  palette: string[];
  frame: { x: number; y: number; width: number; height: number; radius: number; border: number };
}

/** The same shape and messages as the desktop `checkModule`. */
export interface NodeCheck {
  ok: boolean;
  error?: { kind: CodeSandboxErrorKind; message: string };
  loops: boolean;
  maxFrameMs: number;
  durationMs?: number;
}

export interface NodeCheckOptions {
  samples?: number;
  frameTimeoutMs?: number;
  loadTimeoutMs?: number;
}

export type ResolvedNodeCheckOptions = Required<NodeCheckOptions>;

const DEFAULT_SAMPLES = 12;
const DEFAULT_FRAME_TIMEOUT_MS = 250;
const DEFAULT_LOAD_TIMEOUT_MS = 3000;
// Process start and the three.js import come on top of the module's own time limits.
const WALL_SLACK_MS = 8000;

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

const CHILD = here('./node-check-child.ts');
const SANDBOX_DIR = here('../../../apps/desktop/src/features/code-sandbox/');

/** Everything the child may read: its script, what the script imports and the package.json lookups. */
function readableFiles(): string[] {
  return [
    CHILD,
    here('./node-check-shims.js'),
    here('../package.json'),
    here('../../../apps/desktop/package.json'),
    `${SANDBOX_DIR}compose-worker.ts`,
    `${SANDBOX_DIR}errors.ts`,
    `${SANDBOX_DIR}worker-runtime.js`,
    // The package as the child resolves it (a link) and where pnpm keeps it (the real path).
    here('../node_modules/three'),
    realpathSync(here('../node_modules/three')),
  ];
}

function failure(kind: CodeSandboxErrorKind, message: string): NodeCheck {
  return { ok: false, error: { kind, message }, loops: false, maxFrameMs: 0 };
}

function parseResult(value: unknown): NodeCheck | null {
  return typeof value === 'object' && value !== null && 'ok' in value ? (value as NodeCheck) : null;
}

/**
 * Loads `source` in a fresh restricted process, renders it over one loop and reports whether it
 * errors, stays within the frame time and closes the loop (the ops at t=1 equal the ops at t=0).
 */
export function checkModuleInNode(
  source: string,
  scene: NodeScene,
  options: NodeCheckOptions = {},
): Promise<NodeCheck> {
  const resolved: ResolvedNodeCheckOptions = {
    samples: options.samples ?? DEFAULT_SAMPLES,
    frameTimeoutMs: options.frameTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
    loadTimeoutMs: options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
  };
  const wallMs =
    resolved.loadTimeoutMs + (resolved.samples + 2) * Math.max(resolved.frameTimeoutMs, resolved.loadTimeoutMs) + WALL_SLACK_MS;

  return new Promise((resolve) => {
    const args = [
      '--permission',
      // For vm.SourceTextModule, which loads three.js inside the context.
      '--experimental-vm-modules',
      ...readableFiles().map((path) => `--allow-fs-read=${path}`),
      CHILD,
    ];
    // An empty environment: nothing of the developer's reaches model code.
    const child = spawn(process.execPath, args, {
      env: {},
      stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    const nonce = randomBytes(16).toString('hex');
    let result: NodeCheck | null = null;
    let done = false;
    const finish = (result: NodeCheck): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(failure('timeout', 'The check did not finish in time. Make back and front cheaper and do not loop at the top level.'));
    }, wallMs);

    // Only a message that carries this run's nonce counts; the child sends exactly one.
    child.on('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'nonce' in message && message.nonce === nonce && 'result' in message) {
        result = parseResult(message.result);
      }
    });
    child.on('error', () => {
      finish(failure('sandbox-failed', 'The check process could not start.'));
    });
    child.on('close', () => {
      finish(result ?? failure('sandbox-failed', 'The check process ended without a result.'));
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(JSON.stringify({ nonce, source, scene, options: resolved }));
  });
}
