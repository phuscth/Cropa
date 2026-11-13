import { runTask } from '../src/run-task.ts';
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

  for (const c of opts.cases) {
    for (let i = 0; i < runs; i++) {
      total++;
      let attempts = 0;
      const start = performance.now();
      const { done } = runTask(opts.task, c.input, {
        transport: opts.transport,
        provider: opts.provider,
        onEvent: (e) => {
          if (e.type === 'attempt') attempts++;
        },
      });
      const out = await done;
      latencies.push(performance.now() - start);

      if (out.source === 'ai') {
        validAfterRetry++;
        if (attempts === 1) validFirstTry++;
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
  };
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 1000;
}
