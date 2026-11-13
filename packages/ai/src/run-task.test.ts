import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AGENT_ERROR_KINDS } from './errors.ts';
import type { AgentErrorKind } from './errors.ts';
import { MockTransport } from './mock-transport.ts';
import type { MockStep } from './mock-transport.ts';
import { runTask } from './run-task.ts';
import { defineTask } from './task.ts';
import type { Capability, Provider } from './task.ts';
import type { Validation } from './run-task.ts';
import type { Transport } from './transport.ts';

const Answer = z.object({ word: z.string() });

interface Input {
  images?: string[];
}

function makeTask(requires: readonly Capability[] = [], timeoutMs?: number) {
  return defineTask({
    id: 'test-task',
    version: 1,
    schema: Answer,
    requires,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    buildPrompt: (input: Input) => ({
      system: 'sys',
      user: 'say a word',
      ...(input.images ? { images: input.images } : {}),
    }),
    postprocess: (output, { image }) => ({ word: output.word, image }),
    fallback: () => ({ word: 'fallback', image: undefined as string | undefined }),
  });
}

const provider = (...capabilities: Capability[]): Provider => ({ name: 'mock', capabilities });
const valid: MockStep = { json: { word: 'hi' } };
const invalid: MockStep = { json: { word: 7 } };

describe('runTask', () => {
  it('returns the fallback at once, before the transport answers', async () => {
    const transport = new MockTransport([{ ...valid, delayMs: 20 }]);
    const run = runTask(makeTask(), {}, { transport, provider: provider() });
    expect(run.fallback.word).toBe('fallback');
    let settled = false;
    void run.done.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect((await run.done).source).toBe('ai');
  });

  it('accepts a valid first answer with one call', async () => {
    const transport = new MockTransport([valid]);
    const out = await runTask(makeTask(), {}, { transport, provider: provider() }).done;
    expect(out).toEqual({ result: { word: 'hi', image: undefined }, source: 'ai' });
    expect(transport.calls).toHaveLength(1);
  });

  it('retries once with the validation error in the prompt', async () => {
    const transport = new MockTransport([invalid, valid]);
    const out = await runTask(makeTask(), {}, { transport, provider: provider() }).done;
    expect(out.source).toBe('ai');
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.prompt).toBe('say a word');
    const retry = transport.calls[1]?.prompt ?? '';
    expect(retry.startsWith('say a word')).toBe(true);
    expect(retry).toContain('word');
    expect(retry).toContain('did not match the JSON Schema');
  });

  it('falls back with InvalidOutput after two invalid answers', async () => {
    const transport = new MockTransport([invalid, invalid]);
    const out = await runTask(makeTask(), {}, { transport, provider: provider() }).done;
    expect(transport.calls).toHaveLength(2);
    expect(out.source).toBe('fallback');
    expect(out.result.word).toBe('fallback');
    expect(out.notice?.kind).toBe('InvalidOutput');
  });

  it('falls back with InvalidOutput when postprocess throws', async () => {
    const task = defineTask({
      id: 'throws',
      version: 1,
      schema: Answer,
      requires: [],
      buildPrompt: () => ({ system: '', user: '' }),
      postprocess: (): string => {
        throw new Error('nope');
      },
      fallback: () => 'fb',
    });
    const transport = new MockTransport([valid]);
    const out = await runTask(task, {}, { transport, provider: provider() }).done;
    expect(out).toMatchObject({ result: 'fb', source: 'fallback', notice: { kind: 'InvalidOutput' } });
  });

  it('does not retry after a Timeout', async () => {
    const transport = new MockTransport([{ ...valid, delayMs: 50 }, valid]);
    const out = await runTask(makeTask([], 5), {}, { transport, provider: provider() }).done;
    expect(transport.calls).toHaveLength(1);
    expect(out.notice?.kind).toBe('Timeout');
    expect(out.source).toBe('fallback');
  });

  it('cancels mid-delay through the signal without a retry', async () => {
    const transport = new MockTransport([{ ...valid, delayMs: 1000 }, valid]);
    const controller = new AbortController();
    const run = runTask(
      makeTask(),
      {},
      { transport, provider: provider(), signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 5);
    const out = await run.done;
    expect(transport.calls).toHaveLength(1);
    expect(out.notice?.kind).toBe('Cancelled');
  });

  it('never calls the transport when the signal is already aborted', async () => {
    const transport = new MockTransport([valid]);
    const out = await runTask(
      makeTask(),
      {},
      { transport, provider: provider(), signal: AbortSignal.abort() },
    ).done;
    expect(transport.calls).toHaveLength(0);
    expect(out.notice?.kind).toBe('Cancelled');
  });

  it('resolves Cancelled when the abort comes while confirmImages never settles', async () => {
    const transport = new MockTransport([valid]);
    const controller = new AbortController();
    const run = runTask(
      makeTask(['image-in']),
      { images: ['a.png'] },
      {
        transport,
        provider: provider('image-in'),
        signal: controller.signal,
        confirmImages: () => new Promise<boolean>(() => undefined),
      },
    );
    setTimeout(() => {
      controller.abort();
    }, 5);
    const out = await run.done;
    expect(transport.calls).toHaveLength(0);
    expect(out.notice?.kind).toBe('Cancelled');
  });

  it('resolves Cancelled when the transport ignores the signal and never settles', async () => {
    let calls = 0;
    const transport: Transport = {
      run: () => {
        calls++;
        return new Promise(() => undefined);
      },
    };
    const controller = new AbortController();
    const run = runTask(
      makeTask(),
      {},
      { transport, provider: provider(), signal: controller.signal },
    );
    setTimeout(() => {
      controller.abort();
    }, 5);
    const out = await run.done;
    expect(calls).toBe(1);
    expect(out).toMatchObject({ source: 'fallback', notice: { kind: 'Cancelled' } });
  });

  it('discards an answer that arrives after the abort', async () => {
    const controller = new AbortController();
    const transport: Transport = {
      run: () => {
        controller.abort();
        return Promise.resolve({ json: { word: 'late' } });
      },
    };
    const out = await runTask(
      makeTask(),
      {},
      { transport, provider: provider(), signal: controller.signal },
    ).done;
    expect(out).toMatchObject({ source: 'fallback', notice: { kind: 'Cancelled' } });
  });

  const transportKinds = AGENT_ERROR_KINDS.filter((k) => k !== 'Timeout');
  it.each(transportKinds)(
    'maps a %s transport error to the same notice with one call',
    async (kind: AgentErrorKind) => {
      const transport = new MockTransport([{ error: kind }, valid]);
      const out = await runTask(makeTask(), {}, { transport, provider: provider() }).done;
      expect(transport.calls).toHaveLength(1);
      expect(out).toMatchObject({ source: 'fallback', notice: { kind } });
    },
  );

  it('maps a plain-object error to its kind', async () => {
    const transport: Transport = {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      run: () => Promise.reject({ kind: 'UsageLimit' }),
    };
    const out = await runTask(makeTask(), {}, { transport, provider: provider() }).done;
    expect(out.notice?.kind).toBe('UsageLimit');
  });

  it('resolves with Protocol when buildPrompt throws', async () => {
    const task = defineTask({
      id: 'bad-prompt',
      version: 1,
      schema: Answer,
      requires: [],
      buildPrompt: (): { system: string; user: string } => {
        throw new Error('no prompt');
      },
      postprocess: () => 'ai',
      fallback: () => 'fb',
    });
    const transport = new MockTransport([valid]);
    const out = await runTask(task, {}, { transport, provider: provider() }).done;
    expect(out).toMatchObject({ result: 'fb', notice: { kind: 'Protocol', detail: 'no prompt' } });
    expect(transport.calls).toHaveLength(0);
  });

  it('is Locked when the provider lacks a required capability', async () => {
    const transport = new MockTransport([valid]);
    const out = await runTask(
      makeTask(['image-out']),
      {},
      { transport, provider: provider('image-in') },
    ).done;
    expect(transport.calls).toHaveLength(0);
    expect(out.notice?.kind).toBe('Locked');
  });

  describe('image-in', () => {
    const task = makeTask(['image-in']);
    const input = { images: ['a.png'] };

    it('sends nothing when the user declines', async () => {
      const transport = new MockTransport([valid]);
      const out = await runTask(task, input, {
        transport,
        provider: provider('image-in'),
        confirmImages: () => Promise.resolve(false),
      }).done;
      expect(transport.calls).toHaveLength(0);
      expect(out.notice?.kind).toBe('Cancelled');
    });

    it('sends nothing without a confirm callback', async () => {
      const transport = new MockTransport([valid]);
      const out = await runTask(task, input, { transport, provider: provider('image-in') }).done;
      expect(transport.calls).toHaveLength(0);
      expect(out.notice?.kind).toBe('Cancelled');
    });

    it('passes the images on once confirmed', async () => {
      const transport = new MockTransport([valid]);
      const out = await runTask(task, input, {
        transport,
        provider: provider('image-in'),
        confirmImages: (images) => Promise.resolve(images.length === 1),
      }).done;
      expect(out.source).toBe('ai');
      expect(transport.calls[0]?.images).toEqual(['a.png']);
    });

    it('drops images for a task that does not require image-in', async () => {
      const transport = new MockTransport([valid]);
      await runTask(makeTask(), input, { transport, provider: provider('image-in') }).done;
      expect(transport.calls[0]?.images).toEqual([]);
    });
  });

  describe('image-out', () => {
    const task = makeTask(['image-out']);

    it('is a Protocol error when no image comes back, without a retry', async () => {
      const transport = new MockTransport([valid, valid]);
      const out = await runTask(task, {}, { transport, provider: provider('image-out') }).done;
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]?.wantImage).toBe(true);
      expect(out.notice?.kind).toBe('Protocol');
    });

    it('hands the image to postprocess', async () => {
      const transport = new MockTransport([{ ...valid, image: 'out.png' }]);
      const out = await runTask(task, {}, { transport, provider: provider('image-out') }).done;
      expect(out.result.image).toBe('out.png');
    });
  });

  it('reports attempts and transport events', async () => {
    const transport = new MockTransport([{ ...invalid, events: [{ type: 'tick' }] }, valid]);
    const seen: string[] = [];
    await runTask(
      makeTask(),
      {},
      {
        transport,
        provider: provider(),
        onEvent: (e) => {
          seen.push(e.type === 'attempt' ? `attempt ${String(e.attempt)}` : e.type === 'transport' ? e.event.type : e.type);
        },
      },
    ).done;
    expect(seen).toEqual(['attempt 1', 'tick', 'attempt 2']);
  });

  describe('validate', () => {
    type Result = { word: string; image: string | undefined };
    const run = (
      transport: Transport,
      validate: (result: Result, ctx: { attempt: 1 | 2; signal?: AbortSignal }) => Promise<Validation>,
      extra: { signal?: AbortSignal; onEvent?: (e: string) => void } = {},
    ) =>
      runTask(
        makeTask(),
        {},
        {
          transport,
          provider: provider(),
          validate,
          ...(extra.signal ? { signal: extra.signal } : {}),
          onEvent: (e) => {
            extra.onEvent?.(e.type === 'attempt' || e.type === 'validating' ? `${e.type} ${String(e.attempt)}` : e.event.type);
          },
        },
      ).done;

    it('accepts an answer the validator passes, with one call', async () => {
      const transport = new MockTransport([valid]);
      const seen: string[] = [];
      const out = await run(transport, () => Promise.resolve({ ok: true }), {
        onEvent: (e) => seen.push(e),
      });
      expect(out.source).toBe('ai');
      expect(transport.calls).toHaveLength(1);
      expect(seen).toEqual(['attempt 1', 'validating 1']);
    });

    it('sends a failed answer back once with the message, then accepts the next', async () => {
      const transport = new MockTransport([valid, { json: { word: 'again' } }]);
      const seen: string[] = [];
      const out = await run(
        transport,
        (result, { attempt }) =>
          Promise.resolve(
            result.word === 'again' ? { ok: true } : { ok: false, message: `attempt ${String(attempt)} is too slow` },
          ),
        { onEvent: (e) => seen.push(e) },
      );
      expect(out.source).toBe('ai');
      expect(out.result.word).toBe('again');
      expect(transport.calls).toHaveLength(2);
      const retry = transport.calls[1]?.prompt ?? '';
      expect(retry.startsWith('say a word')).toBe(true);
      expect(retry).toContain('did not pass the check');
      expect(retry).toContain('attempt 1 is too slow');
      expect(seen).toEqual(['attempt 1', 'validating 1', 'attempt 2', 'validating 2']);
    });

    it('falls back with InvalidOutput and the message when the retry fails too', async () => {
      const transport = new MockTransport([valid, valid]);
      const out = await run(transport, () => Promise.resolve({ ok: false, message: 'it does not loop' }));
      expect(transport.calls).toHaveLength(2);
      expect(out.source).toBe('fallback');
      expect(out.notice).toEqual({ kind: 'InvalidOutput', detail: 'it does not loop' });
    });

    it('does not resend when the validator says retry is pointless', async () => {
      const transport = new MockTransport([valid, valid]);
      const out = await run(transport, () => Promise.resolve({ ok: false, retry: false, message: 'no WebGL' }));
      expect(transport.calls).toHaveLength(1);
      expect(out.source).toBe('fallback');
      expect(out.notice).toEqual({ kind: 'InvalidOutput', detail: 'no WebGL' });
    });

    it('resolves Cancelled when the abort comes during validation', async () => {
      const abort = new AbortController();
      const transport = new MockTransport([valid, valid]);
      const out = await run(
        transport,
        () => {
          queueMicrotask(() => { abort.abort(); });
          return new Promise<Validation>(() => undefined);
        },
        { signal: abort.signal },
      );
      expect(transport.calls).toHaveLength(1);
      expect(out.source).toBe('fallback');
      expect(out.notice?.kind).toBe('Cancelled');
    });

    it('falls back with Protocol when the validator throws', async () => {
      const transport = new MockTransport([valid]);
      const out = await run(transport, () => Promise.reject(new Error('sandbox crashed')));
      expect(out.source).toBe('fallback');
      expect(out.notice).toEqual({ kind: 'Protocol', detail: 'sandbox crashed' });
    });
  });
});
