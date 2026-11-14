// A headless Chromium (Edge or Chrome, already installed) driven over the DevTools protocol, so the
// eval can render background frames in the same sandbox the app uses. It runs with a throwaway
// profile and no name resolution, and it is always closed and its profile removed.
//
// No dependency: the protocol is a WebSocket carrying JSON, and Node has a global WebSocket.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const ENV_VAR = 'CROPA_EVAL_BROWSER';
const START_TIMEOUT_MS = 20_000;
const DEFAULT_LIFETIME_MS = 15 * 60_000;

export interface EvalBrowser {
  /** Evaluates an expression in the blank page, waits for a promise it returns and gives back its value. */
  evaluate: <T>(expression: string) => Promise<T>;
  /** Closes the browser and removes its profile. Safe to call twice. */
  close: () => Promise<void>;
}

function candidates(): string[] {
  const env = process.env;
  switch (process.platform) {
    case 'win32': {
      const roots = [env['ProgramFiles(x86)'], env['ProgramFiles'], env['LOCALAPPDATA']].filter(
        (root): root is string => typeof root === 'string' && root !== '',
      );
      return roots.flatMap((root) => [
        join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]);
    }
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ];
    default: {
      const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
      const dirs = (env['PATH'] ?? '').split(delimiter).filter((dir) => dir !== '');
      return dirs.flatMap((dir) => names.map((name) => join(dir, name)));
    }
  }
}

/** The Chromium to use: $CROPA_EVAL_BROWSER, else the first Edge or Chrome found in the usual places. */
export function findBrowser(): string {
  const chosen = process.env[ENV_VAR];
  if (chosen !== undefined && chosen !== '') {
    if (!existsSync(chosen)) throw new Error(`${ENV_VAR} is set to ${chosen}, which does not exist.`);
    return chosen;
  }
  const found = candidates().find((path) => existsSync(path));
  if (found === undefined) {
    throw new Error(
      `No Edge or Chrome found. Install one, or set ${ENV_VAR} to the path of a Chromium-based browser executable.`,
    );
  }
  return found;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function readDebugPort(profile: string, child: ChildProcess): Promise<{ port: number; path: string }> {
  const file = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The browser exited with code ${String(child.exitCode)} before it was ready.`);
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, 'utf8').split('\n');
      if (port && path) return { port: Number(port), path: path.trim() };
    }
    await sleep(100);
  }
  throw new Error('The browser did not open its debugging port in time.');
}

interface Reply {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

/**
 * Starts the browser. It is killed after `lifetimeMs` whatever it is doing, so a hung page cannot
 * keep an eval run alive.
 */
export async function launchBrowser(options: { lifetimeMs?: number } = {}): Promise<EvalBrowser> {
  const executable = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'cropa-eval-browser-'));
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const exited = new Promise<void>((done) => {
    child.once('exit', () => {
      done();
    });
    child.once('error', () => {
      done();
    });
  });
  const lifetime = setTimeout(() => {
    child.kill();
  }, options.lifetimeMs ?? DEFAULT_LIFETIME_MS);
  let socket: WebSocket | null = null;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(lifetime);
    socket?.close();
    child.kill();
    await Promise.race([exited, sleep(5000)]);
    // The browser can hold the profile for a moment after it exits, most of all on Windows.
    rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  };

  try {
    const { port, path } = await readDebugPort(profile, child);
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${path}`);
    socket = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => {
        resolve();
      });
      ws.addEventListener('error', () => {
        reject(new Error('Could not connect to the browser debugging port.'));
      });
    });

    let nextId = 1;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    ws.addEventListener('message', (event) => {
      const reply = JSON.parse(String(event.data)) as Reply;
      if (reply.id === undefined) return;
      const waiting = pending.get(reply.id);
      if (!waiting) return;
      pending.delete(reply.id);
      if (reply.error) waiting.reject(new Error(reply.error.message ?? 'The browser refused the command.'));
      else waiting.resolve(reply.result);
    });
    ws.addEventListener('close', () => {
      for (const waiting of pending.values()) waiting.reject(new Error('The browser closed the connection.'));
      pending.clear();
    });

    const send = (method: string, params: object, sessionId?: string): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
      });

    const { targetInfos } = (await send('Target.getTargets', {})) as {
      targetInfos: { targetId: string; type: string }[];
    };
    const page = targetInfos.find((info) => info.type === 'page');
    if (!page) throw new Error('The browser has no page to drive.');
    const { sessionId } = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })) as {
      sessionId: string;
    };

    return {
      close,
      async evaluate<T>(expression: string): Promise<T> {
        const reply = (await send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        )) as { result: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
        if (reply.exceptionDetails) {
          const { exception, text } = reply.exceptionDetails;
          throw new Error(exception?.description ?? text ?? 'The page threw.');
        }
        return reply.result.value as T;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
