import { AGENT_ERROR_KINDS, AgentError, paletteNameTask, runTask } from '@cropa/ai';
import type { Channel } from '@tauri-apps/api/core';
import { describe, expect, it } from 'vitest';

import type { AiError, AiEvent, AiMockScript_Deserialize, AiOutput_Serialize } from '../../lib/bindings.ts';
import { createDesktopTransport, type TransportDeps } from './transport.ts';

type RunResult = { status: 'ok'; data: AiOutput_Serialize } | { status: 'error'; error: AiError };

const REQUEST = {
  system: 'sys',
  prompt: 'ask',
  schema: { type: 'object' },
  images: [] as string[],
  wantImage: false,
  timeoutMs: 45_000,
};

function ok(json: unknown = null, image: string | null = null): RunResult {
  return { status: 'ok', data: { json, image } };
}

/** A stand-in for the commands: records the call and answers with `answer`. */
function harness(answer: (emit: (event: AiEvent) => void) => Promise<RunResult> | RunResult) {
  const calls: { runId: string; provider: string; request: unknown; mock: unknown }[] = [];
  const cancelled: string[] = [];
  let emit: (event: AiEvent) => void = () => undefined;
  const deps: Partial<TransportDeps> = {
    aiRun: (runId, provider, request, mock) => {
      calls.push({ runId, provider, request, mock });
      return Promise.resolve(answer(emit));
    },
    aiCancel: (runId) => {
      cancelled.push(runId);
      return Promise.resolve({ status: 'ok', data: null });
    },
    channel: (onMessage) => {
      emit = onMessage;
      return {} as Channel<AiEvent>;
    },
    newRunId: () => 'run-1',
  };
  return { deps, calls, cancelled };
}

describe('the desktop transport', () => {
  it('sends the request to the provider with the images as bare base64', async () => {
    const { deps, calls } = harness(() => ok({}));
    const mock: AiMockScript_Deserialize = { delayMs: 0, events: [], result: {}, error: null };
    const transport = createDesktopTransport({ provider: 'mock', model: null }, deps, mock);
    await transport.run(
      { ...REQUEST, images: ['data:image/png;base64,AAAA', 'BBBB'], wantImage: true },
      {},
    );
    expect(calls).toEqual([
      {
        runId: 'run-1',
        provider: 'mock',
        request: {
          system: 'sys',
          prompt: 'ask',
          schema: { type: 'object' },
          images: ['AAAA', 'BBBB'],
          wantImage: true,
          model: null,
          effort: 'low',
          timeoutMs: 45_000,
        },
        mock,
      },
    ]);
  });

  it('sends the chosen model with the run, and the provider of the transport', async () => {
    const { deps, calls } = harness(() => ok({}));
    await createDesktopTransport({ provider: 'claude', model: 'opus' }, deps).run(REQUEST, {});
    await createDesktopTransport({ provider: 'codex', model: 'gpt-6.1-sol' }, deps).run(REQUEST, {});
    expect(calls.map((c) => [c.provider, (c.request as { model: string | null }).model])).toEqual([
      ['claude', 'opus'],
      ['codex', 'gpt-6.1-sol'],
    ]);
  });

  it('sends the effort the task asked for, and low when it asked for none', async () => {
    const { deps, calls } = harness(() => ok({}));
    const transport = createDesktopTransport({ provider: 'codex', model: null }, deps);
    for (const effort of ['medium', 'high'] as const) await transport.run({ ...REQUEST, effort }, {});
    await transport.run(REQUEST, {});
    expect(calls.map((c) => (c.request as { effort: string }).effort)).toEqual(['medium', 'high', 'low']);
  });

  it('passes progress events on and drops kinds it does not know', async () => {
    const { deps } = harness((emit) => {
      emit({ kind: 'started' });
      emit({ kind: 'delta', text: 'hi' });
      emit({ kind: 'thinking', text: 'hm' });
      emit({ kind: 'output', text: '{"a"' });
      emit({ kind: 'future' } as unknown as AiEvent);
      return ok({});
    });
    const seen: unknown[] = [];
    await createDesktopTransport({ provider: 'codex', model: null }, deps).run(REQUEST, { onEvent: (e) => seen.push(e) });
    expect(seen).toEqual([
      { type: 'started' },
      { type: 'delta', text: 'hi' },
      { type: 'thinking', text: 'hm' },
      { type: 'output', text: '{"a"' },
    ]);
  });

  it('returns the JSON and image, leaving out what the run did not produce', async () => {
    const full = harness(() => ok({ a: 1 }, 'data:image/png;base64,Zm9v'));
    expect(await createDesktopTransport({ provider: 'codex', model: null }, full.deps).run(REQUEST, {})).toEqual({
      json: { a: 1 },
      image: 'data:image/png;base64,Zm9v',
    });
    const empty = harness(() => ok());
    const output = await createDesktopTransport({ provider: 'codex', model: null }, empty.deps).run(REQUEST, {});
    expect(output).toEqual({});
    expect('json' in output).toBe(false);
    expect('image' in output).toBe(false);
  });

  it.each(AGENT_ERROR_KINDS.filter((kind) => kind !== 'Protocol'))(
    'turns a %s failure into an AgentError of the same kind',
    async (kind) => {
      const { deps } = harness(() => ({ status: 'error', error: { kind } as AiError }));
      await expect(createDesktopTransport({ provider: 'codex', model: null }, deps).run(REQUEST, {})).rejects.toMatchObject({
        name: 'AgentError',
        kind,
      });
    },
  );

  it('keeps the detail of a protocol failure', async () => {
    const { deps } = harness(() => ({ status: 'error', error: { kind: 'Protocol', detail: 'bad' } }));
    await expect(createDesktopTransport({ provider: 'codex', model: null }, deps).run(REQUEST, {})).rejects.toMatchObject({
      kind: 'Protocol',
      message: 'bad',
    });
  });

  it('treats a request Rust refused as a protocol failure', async () => {
    for (const error of [
      { kind: 'InvalidRequest', detail: 'model' },
      { kind: 'RunIdInUse' },
    ] as AiError[]) {
      const { deps } = harness(() => ({ status: 'error', error }));
      await expect(createDesktopTransport({ provider: 'codex', model: null }, deps).run(REQUEST, {})).rejects.toMatchObject({
        kind: 'Protocol',
      });
    }
  });

  it('treats a rejected invoke as a protocol failure', async () => {
    const { deps } = harness(() => Promise.reject(new Error('not allowed')));
    const failure: unknown = await createDesktopTransport({ provider: 'codex', model: null }, deps)
      .run(REQUEST, {})
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AgentError);
    expect(failure).toMatchObject({ kind: 'Protocol', message: 'not allowed' });
  });

  it('cancels the run by its id when aborted, and ignores the late answer', async () => {
    let answer: (result: RunResult) => void = () => undefined;
    const { deps, cancelled } = harness(() => new Promise<RunResult>((r) => { answer = r; }));
    const controller = new AbortController();
    const running = createDesktopTransport({ provider: 'codex', model: null }, deps).run(REQUEST, { signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toMatchObject({ kind: 'Cancelled' });
    expect(cancelled).toEqual(['run-1']);
    answer(ok({}));
  });

  it('does not start a run when the signal is already aborted', async () => {
    const { deps, calls } = harness(() => ok({}));
    const signal = AbortSignal.abort();
    await expect(createDesktopTransport({ provider: 'codex', model: null }, deps).run(REQUEST, { signal })).rejects.toMatchObject({
      kind: 'Cancelled',
    });
    expect(calls).toEqual([]);
  });

  it('runs a task end to end', async () => {
    const { deps } = harness(() => ok({ name: 'Quiet Harbour', mood: 'calm' }));
    const { done } = runTask(
      paletteNameTask,
      { colors: ['#1e3a8a'] },
      { transport: createDesktopTransport({ provider: 'mock', model: null }, deps), provider: { name: 'mock', capabilities: [] } },
    );
    const outcome = await done;
    expect(outcome.source).toBe('ai');
    expect(outcome.result).toEqual({ name: 'Quiet Harbour', mood: 'calm' });
  });
});
