import { AgentError } from './errors.ts';
import type { AgentErrorKind } from './errors.ts';
import type {
  Transport,
  TransportEvent,
  TransportOptions,
  TransportOutput,
  TransportRequest,
} from './transport.ts';

export type MockStep =
  | { json?: unknown; image?: string; delayMs?: number; events?: TransportEvent[] }
  | { error: AgentErrorKind; delayMs?: number };

export type MockScript = MockStep[] | ((req: TransportRequest, call: number) => MockStep);

/** A scripted transport for tests, UI work and the eval. */
export class MockTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  readonly #script: MockScript;

  constructor(script: MockScript) {
    this.#script = script;
  }

  async run(req: TransportRequest, opts: TransportOptions): Promise<TransportOutput> {
    const call = this.calls.length;
    this.calls.push(req);

    const step = this.#next(req, call);
    if (step === undefined) {
      throw new AgentError('Protocol', 'mock script ran out of steps');
    }

    const delayMs = step.delayMs ?? 0;
    if (delayMs > req.timeoutMs) {
      await wait(req.timeoutMs, opts.signal);
      throw new AgentError('Timeout');
    }
    await wait(delayMs, opts.signal);

    if ('error' in step) throw new AgentError(step.error);

    for (const event of step.events ?? []) opts.onEvent?.(event);
    const out: TransportOutput = {};
    if ('json' in step) out.json = step.json;
    if (step.image !== undefined) out.image = step.image;
    return out;
  }

  #next(req: TransportRequest, call: number): MockStep | undefined {
    return typeof this.#script === 'function' ? this.#script(req, call) : this.#script[call];
  }
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AgentError('Cancelled'));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AgentError('Cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
