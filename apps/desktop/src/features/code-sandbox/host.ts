import { sandboxDocument } from './bootstrap.ts';
import { CodeSandboxError } from './errors.ts';
import type { CodeScene } from './sandbox.ts';

export type HostMessage =
  | { type: 'start'; code: string }
  | { type: 'frame'; id: number; t: number; scene: CodeScene }
  | { type: 'terminate' };

export interface SandboxHost {
  readonly ready: Promise<void>;
  send(message: HostMessage): void;
  onMessage(listener: (data: unknown) => void): () => void;
  dispose(): void;
}

export type CreateHost = () => SandboxHost;

const DEFAULT_BOOT_TIMEOUT_MS = 5000;

function isBootReady(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'boot-ready';
}

/**
 * Hosts the sandbox in a hidden iframe. `sandbox="allow-scripts"` without `allow-same-origin` gives
 * the document an opaque origin, so nothing inside can reach the app's DOM, storage or IPC.
 */
export function createIframeHost(options: { bootTimeoutMs?: number; doc?: Document } = {}): SandboxHost {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;
  const bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;

  const iframe = doc.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  iframe.style.cssText =
    'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
  iframe.srcdoc = sandboxDocument();

  const listeners = new Set<(data: unknown) => void>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function onWindowMessage(event: MessageEvent): void {
    if (event.source !== iframe.contentWindow) return;
    for (const listener of [...listeners]) listener(event.data);
  }
  win.addEventListener('message', onWindowMessage);

  const ready = new Promise<void>((resolve, reject) => {
    const stop = (): void => {
      listeners.delete(onBoot);
      clearTimeout(timer);
    };
    const onBoot = (data: unknown): void => {
      if (!isBootReady(data)) return;
      stop();
      resolve();
    };
    listeners.add(onBoot);
    timer = setTimeout(() => {
      stop();
      reject(
        new CodeSandboxError('sandbox-failed', `The background sandbox did not start within ${bootTimeoutMs} ms.`),
      );
    }, bootTimeoutMs);
  });
  // A host disposed before anyone awaits `ready` must not raise an unhandled rejection.
  ready.catch(() => undefined);

  doc.body.append(iframe);

  return {
    ready,
    send(message) {
      iframe.contentWindow?.postMessage(message, '*');
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      iframe.contentWindow?.postMessage({ type: 'terminate' }, '*');
      clearTimeout(timer);
      win.removeEventListener('message', onWindowMessage);
      listeners.clear();
      iframe.remove();
    },
  };
}
