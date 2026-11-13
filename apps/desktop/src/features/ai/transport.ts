import { AgentError } from '@cropa/ai';
import type { Transport, TransportOutput, TransportRequest } from '@cropa/ai';
import { Channel } from '@tauri-apps/api/core';

import {
  commands,
  type AiError,
  type AiEvent,
  type AiMockScript_Deserialize,
  type AiRequest_Deserialize,
} from '../../lib/bindings.ts';

const PNG_DATA_URL_PREFIX = /^data:image\/png;base64,/;

export interface TransportDeps {
  aiRun: typeof commands.aiRun;
  aiCancel: typeof commands.aiCancel;
  /** A channel that calls `onMessage` with each event of one run. */
  channel: (onMessage: (event: AiEvent) => void) => Channel<AiEvent>;
  /** An id of 1 to 64 characters from `A-Za-z0-9_-`. */
  newRunId: () => string;
}

const defaultDeps: TransportDeps = {
  aiRun: commands.aiRun,
  aiCancel: commands.aiCancel,
  channel: (onMessage) => {
    const channel = new Channel<AiEvent>();
    channel.onmessage = onMessage;
    return channel;
  },
  newRunId: () => crypto.randomUUID(),
};

function toAgentError(error: AiError): AgentError {
  switch (error.kind) {
    case 'Protocol':
      return new AgentError('Protocol', error.detail);
    case 'InvalidRequest':
      return new AgentError('Protocol', `invalid request: ${error.detail}`);
    case 'RunIdInUse':
      return new AgentError('Protocol', 'run id already in use');
    default:
      return new AgentError(error.kind);
  }
}

function toRequest(req: TransportRequest): AiRequest_Deserialize {
  return {
    system: req.system,
    prompt: req.prompt,
    schema: req.schema,
    // Rust accepts bare base64 PNG only and rejects anything else.
    images: req.images.map((image) => image.replace(PNG_DATA_URL_PREFIX, '')),
    wantImage: req.wantImage,
    model: null,
    timeoutMs: req.timeoutMs,
  };
}

/**
 * The `@cropa/ai` transport over the `ai_run` and `ai_cancel` commands. The
 * window starts no process: Rust runs the provider's CLI.
 *
 * `mock` is the scripted result of the debug-only mock provider.
 */
export function createDesktopTransport(
  provider: string,
  deps: Partial<TransportDeps> = {},
  mock: AiMockScript_Deserialize | null = null,
): Transport {
  const { aiRun, aiCancel, channel, newRunId } = { ...defaultDeps, ...deps };

  return {
    run(req, { signal, onEvent }) {
      if (signal?.aborted) return Promise.reject(new AgentError('Cancelled'));
      const runId = newRunId();

      return new Promise<TransportOutput>((resolve, reject) => {
        let settled = false;
        const settle = (finish: () => void) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          finish();
        };
        function onAbort() {
          try {
            void Promise.resolve(aiCancel(runId)).catch(() => undefined);
          } catch {
            // Cancelling is best effort: the run is abandoned either way.
          }
          settle(() => { reject(new AgentError('Cancelled')); });
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        const events = channel((event) => {
          if (settled) return;
          // A kind this build does not know is ignored.
          switch (event.kind) {
            case 'started':
              onEvent?.({ type: 'started' });
              break;
            case 'delta':
              onEvent?.({ type: 'delta', text: event.text });
              break;
          }
        });

        aiRun(runId, provider, toRequest(req), mock, events).then(
          (result) => {
            settle(() => {
              if (result.status === 'error') {
                reject(toAgentError(result.error));
                return;
              }
              const output: TransportOutput = {};
              if (result.data.json != null) output.json = result.data.json;
              if (result.data.image != null) output.image = result.data.image;
              resolve(output);
            });
          },
          (cause: unknown) => {
            settle(() => {
              reject(new AgentError('Protocol', cause instanceof Error ? cause.message : String(cause)));
            });
          },
        );
      });
    },
  };
}
