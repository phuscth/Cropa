import { runTask } from '../src/run-task.ts';
import type { Validation } from '../src/run-task.ts';
import type { Provider, Task } from '../src/task.ts';
import type { Transport } from '../src/transport.ts';

export interface EvalCase {
  id: string;
  input: unknown;
}

export interface EvalReport {
  task: string;
  version: number;
  provider: string;
  cases: number;
  /** Answers valid on the first attempt. */
  validFirstTry: number;
  /** Answers valid on either attempt (cumulative). */
  validAfterRetry: number;
  /** validFirstTry / cases, 0..1. */
  validFirstTryRate: number;
  /** validAfterRetry / cases, 0..1. */
  validAfterRetryRate: number;
  p50Ms: number;
  p95Ms: number;
  notices: Record<string, number>;
  /** Present when the eval ran with a validator. */
  validation?: ValidationReport;
}

/** What a validator saw in one answer, beyond its verdict. */
export interface EvalCheck {
  validation: Validation;
  /** The answer ran without an error. */
  ran: boolean;
  /** The answer ran and its loop closes. */
  loops: boolean;
  /** The slowest frame, in milliseconds. */
  maxFrameMs: number;
}

export interface ValidationReport {
  /** The first answer passed the whole check. */
  runnableFirstTry: number;
  /** An answer passed the whole check on either attempt. */
  runnableAfterRetry: number;
  /** The first answer ran and its loop closes. */
  loopClosedFirstTry: number;
  /** An answer ran and its loop closes, on either attempt. */
  loopClosedAfterRetry: number;
  runnableFirstTryRate: number;
  runnableAfterRetryRate: number;
  loopClosedFirstTryRate: number;
  loopClosedAfterRetryRate: number;
  /** The slowest frame over the accepted answers. */
  maxFrameMs: number;
  /** 95th percentile, over the accepted answers, of each one's slowest frame. */
  p95FrameMs: number;
}

export interface EvalOptions {
  // The eval handles tasks of any input and output type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task: Task<any, any, any>;
  cases: readonly EvalCase[];
  transport: Transport;
  provider: Provider;
  /** How many times each case runs. */
  runs?: number;
  /** Checks each postprocessed answer; a failed one is sent back once, as in the app. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  validate?: (input: any, result: any, ctx: { attempt: 1 | 2; signal?: AbortSignal }) => Promise<EvalCheck>;
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}

/** Runs every case and reports counts and latency. The report holds no prompts or answers. */
export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const runs = opts.runs ?? 1;
  let total = 0;
  let validFirstTry = 0;
  let validAfterRetry = 0;
  const latencies: number[] = [];
  const notices: Record<string, number> = {};
  let passedFirst = 0;
  let loopedFirst = 0;
  let loopedEither = 0;
  const frameMs: number[] = [];

  for (const c of opts.cases) {
    for (let i = 0; i < runs; i++) {
      total++;
      let attempts = 0;
      const checks = new Map<1 | 2, EvalCheck>();
      const { validate } = opts;
      const start = performance.now();
      const { done } = runTask(opts.task, c.input, {
        transport: opts.transport,
        provider: opts.provider,
        onEvent: (e) => {
          if (e.type === 'attempt') attempts++;
        },
        ...(validate
          ? {
              validate: async (result: unknown, ctx: { attempt: 1 | 2; signal?: AbortSignal }) => {
                const check = await validate(c.input, result, ctx);
                checks.set(ctx.attempt, check);
                return check.validation;
              },
            }
          : {}),
      });
      const out = await done;
      latencies.push(performance.now() - start);

      if (out.source === 'ai') {
        validAfterRetry++;
        if (attempts === 1) validFirstTry++;
      }
      if (validate) {
        const first = checks.get(1);
        const second = checks.get(2);
        if (first?.validation.ok) passedFirst++;
        if (first?.ran && first.loops) loopedFirst++;
        if ((first?.ran && first.loops) || (second?.ran && second.loops)) loopedEither++;
        if (out.source === 'ai') {
          // The accepted answer is the last one checked.
          const accepted = checks.get(attempts === 2 ? 2 : 1);
          if (accepted) frameMs.push(accepted.maxFrameMs);
        }
      }
      if (out.notice) notices[out.notice.kind] = (notices[out.notice.kind] ?? 0) + 1;
    }
  }

  latencies.sort((a, b) => a - b);
  return {
    task: opts.task.id,
    version: opts.task.version,
    provider: opts.provider.name,
    cases: total,
    validFirstTry,
    validAfterRetry,
    validFirstTryRate: rate(validFirstTry, total),
    validAfterRetryRate: rate(validAfterRetry, total),
    p50Ms: Math.round(percentile(latencies, 50)),
    p95Ms: Math.round(percentile(latencies, 95)),
    notices,
    ...(opts.validate
      ? {
          validation: {
            runnableFirstTry: passedFirst,
            runnableAfterRetry: validAfterRetry,
            loopClosedFirstTry: loopedFirst,
            loopClosedAfterRetry: loopedEither,
            runnableFirstTryRate: rate(passedFirst, total),
            runnableAfterRetryRate: rate(validAfterRetry, total),
            loopClosedFirstTryRate: rate(loopedFirst, total),
            loopClosedAfterRetryRate: rate(loopedEither, total),
            maxFrameMs: round1(Math.max(0, ...frameMs)),
            p95FrameMs: round1(percentile(frameMs.sort((a, b) => a - b), 95)),
          },
        }
      : {}),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 1000;
}
