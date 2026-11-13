import { z } from 'zod';

import { TaskOutputError, toAgentErrorKind } from './errors.ts';
import type { AiErrorKind } from './errors.ts';
import type { Provider, Task } from './task.ts';
import type { Transport, TransportEvent, TransportOutput, TransportRequest } from './transport.ts';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_DETAIL_CHARS = 1000;

/** Why a run ended on the fallback. `detail` is for developers only. */
export interface TaskNotice {
  kind: AiErrorKind;
  detail?: string;
}

export interface TaskResult<T> {
  result: T;
  source: 'ai' | 'fallback';
  notice?: TaskNotice;
}

export type TaskEvent =
  | { type: 'attempt'; attempt: 1 | 2 }
  | { type: 'validating'; attempt: 1 | 2 }
  | { type: 'transport'; event: TransportEvent };

/**
 * The verdict of a validator. A failed answer is sent back once with the message, unless
 * `retry` is false (the problem is in the environment, so another answer would not help).
 */
export type Validation = { ok: true } | { ok: false; message: string; retry?: boolean };

export interface RunTaskOptions<T = unknown> {
  transport: Transport;
  provider: Provider;
  signal?: AbortSignal;
  onEvent?: (event: TaskEvent) => void;
  /** Asks the user before images leave the machine. Required by `image-in` tasks. */
  confirmImages?: (images: readonly string[]) => Promise<boolean>;
  timeoutMs?: number;
  /** Checks the postprocessed result, for what a schema cannot say (for example that code runs). */
  validate?: (result: T, ctx: { attempt: 1 | 2; signal?: AbortSignal }) => Promise<Validation>;
}

export interface TaskRun<T> {
  /** Ready at once, so the UI never waits on the AI. */
  fallback: T;
  /** Never rejects: every failure resolves with the fallback and a notice. */
  done: Promise<TaskResult<T>>;
}

export function runTask<I, S extends z.ZodType, T>(
  task: Task<I, S, T>,
  input: I,
  opts: RunTaskOptions<T>,
): TaskRun<T> {
  const fallback = task.fallback(input);

  const fail = (notice: TaskNotice): TaskResult<T> => ({
    result: fallback,
    source: 'fallback',
    notice,
  });

  const execute = async (): Promise<TaskResult<T>> => {
    const { signal } = opts;
    const aborted = () => signal?.aborted === true;

    const missing = task.requires.filter((c) => !opts.provider.capabilities.includes(c));
    if (missing.length > 0) {
      return fail({ kind: 'Locked', detail: `missing capabilities: ${missing.join(', ')}` });
    }
    if (aborted()) return fail({ kind: 'Cancelled' });

    const prompt = task.buildPrompt(input);
    const needsImages = task.requires.includes('image-in');
    const images = needsImages ? (prompt.images ?? []) : [];

    if (needsImages) {
      const confirmed = opts.confirmImages
        ? await raceAbort(opts.confirmImages(images), signal)
        : false;
      if (confirmed === ABORTED) return fail({ kind: 'Cancelled' });
      if (!confirmed) return fail({ kind: 'Cancelled', detail: 'images not confirmed' });
      if (aborted()) return fail({ kind: 'Cancelled' });
    }

    const wantImage = task.requires.includes('image-out');
    const request: TransportRequest = {
      system: prompt.system,
      prompt: prompt.user,
      schema: task.jsonSchema,
      images,
      wantImage,
      timeoutMs: task.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };

    const send = async (
      attempt: 1 | 2,
      req: TransportRequest,
    ): Promise<{ out: TransportOutput } | { notice: TaskNotice }> => {
      if (aborted()) return { notice: { kind: 'Cancelled' } };
      opts.onEvent?.({ type: 'attempt', attempt });
      try {
        const out = await raceAbort(
          opts.transport.run(req, {
            ...(signal ? { signal } : {}),
            onEvent: (event) => opts.onEvent?.({ type: 'transport', event }),
          }),
          signal,
        );
        // An answer that arrives after an abort is discarded.
        if (out === ABORTED || aborted()) return { notice: { kind: 'Cancelled' } };
        return { out };
      } catch (err) {
        return { notice: { kind: toAgentErrorKind(err, signal) } };
      }
    };

    type Checked =
      | { kind: 'done'; value: TaskResult<T> }
      | { kind: 'again'; note: string; notice: TaskNotice; retry: boolean };

    // Schema, postprocess and the optional validator, in that order, for one answer.
    const check = async (out: TransportOutput, attempt: 1 | 2): Promise<Checked> => {
      const parsed = task.schema.safeParse(out.json);
      if (!parsed.success) {
        return {
          kind: 'again',
          note: retryNote(parsed.error),
          notice: { kind: 'InvalidOutput', detail: errorSummary(parsed.error) },
          retry: true,
        };
      }
      let result: T;
      try {
        const image = out.image;
        result = task.postprocess(parsed.data, image === undefined ? { input } : { input, image });
      } catch (err) {
        if (err instanceof TaskOutputError) {
          const message = err.message.slice(0, MAX_DETAIL_CHARS);
          return {
            kind: 'again',
            note: validationRetryNote(message),
            notice: { kind: 'InvalidOutput', detail: message },
            retry: true,
          };
        }
        return { kind: 'done', value: fail({ kind: 'InvalidOutput', detail: messageOf(err) }) };
      }
      const { validate } = opts;
      if (!validate) return { kind: 'done', value: { result, source: 'ai' } };

      opts.onEvent?.({ type: 'validating', attempt });
      let verdict: Validation | typeof ABORTED;
      try {
        verdict = await raceAbort(validate(result, signal ? { attempt, signal } : { attempt }), signal);
      } catch (err) {
        return { kind: 'done', value: fail({ kind: 'Protocol', detail: messageOf(err) }) };
      }
      if (verdict === ABORTED || aborted()) {
        return { kind: 'done', value: fail({ kind: 'Cancelled' }) };
      }
      if (verdict.ok) return { kind: 'done', value: { result, source: 'ai' } };
      const message = verdict.message.slice(0, MAX_DETAIL_CHARS);
      return {
        kind: 'again',
        note: validationRetryNote(message),
        notice: { kind: 'InvalidOutput', detail: message },
        retry: verdict.retry !== false,
      };
    };

    const first = await send(1, request);
    if ('notice' in first) return fail(first.notice);
    if (wantImage && first.out.image === undefined) {
      return fail({ kind: 'Protocol', detail: 'the provider returned no image' });
    }
    const checkedFirst = await check(first.out, 1);
    if (checkedFirst.kind === 'done') return checkedFirst.value;
    if (!checkedFirst.retry) return fail(checkedFirst.notice);

    const second = await send(2, {
      ...request,
      prompt: `${request.prompt}\n\n${checkedFirst.note}`,
    });
    if ('notice' in second) return fail(second.notice);
    if (wantImage && second.out.image === undefined) {
      return fail({ kind: 'Protocol', detail: 'the provider returned no image' });
    }
    const checkedSecond = await check(second.out, 2);
    if (checkedSecond.kind === 'done') return checkedSecond.value;
    return fail(checkedSecond.notice);
  };

  const done = execute().catch((err: unknown) =>
    fail({ kind: 'Protocol', detail: messageOf(err) }),
  );
  return { fallback, done };
}

const ABORTED = Symbol('aborted');

/** Settles with the promise, or with ABORTED as soon as the signal aborts. */
function raceAbort<V>(promise: Promise<V>, signal: AbortSignal | undefined): Promise<V | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      resolve(ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function errorSummary(error: z.ZodError): string {
  return z.prettifyError(error).slice(0, MAX_DETAIL_CHARS);
}

function retryNote(error: z.ZodError): string {
  return [
    'Your previous reply did not match the JSON Schema.',
    errorSummary(error),
    'Reply again with JSON that matches the schema.',
  ].join('\n');
}

function validationRetryNote(message: string): string {
  return [
    'Your previous answer did not pass the check:',
    message,
    'Reply again with JSON that matches the schema and fixes this.',
  ].join('\n');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'unexpected error';
}
