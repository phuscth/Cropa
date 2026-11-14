import { toAgentErrorKind } from '../src/errors.ts';
import { runTask } from '../src/run-task.ts';
import type { Validation } from '../src/run-task.ts';
import type { Provider, Task } from '../src/task.ts';
import type { Effort, Transport } from '../src/transport.ts';

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
  /** Ids of the cases whose final answer fell back; a case that failed in several runs appears once. */
  failing: string[];
  /** Present when the eval ran with a validator. */
  validation?: ValidationReport;
}

/** One call to the transport inside a case run. */
export interface AttemptRecord {
  attempt: 1 | 2;
  ms: number;
  /** The transport rejected. */
  error?: { kind: string; message: string };
  /** What the CLI wrote to stderr, as the transport scrubbed it. */
  stderrTail?: string;
  /** The validator's view; absent when the answer failed the schema or postprocess. */
  check?: { ok: boolean; message?: string; ran: boolean; loops: boolean; maxFrameMs: number };
  /** The raw answer, kept only when this attempt was not the accepted one. */
  output?: unknown;
}

/** What one run of one case did, for finding out why it failed. */
export interface CaseRecord {
  id: string;
  run: number;
  passed: boolean;
  ms: number;
  notice?: { kind: string; detail?: string };
  /** The note sent with the retry: why attempt 1 was refused (schema, postprocess or check). */
  retryNote?: string;
  attempts: AttemptRecord[];
  /** The accepted answer, as the task produced it, when the case passed. */
  result?: unknown;
}

const MAX_DETAIL_CHARS = 1000;
const MAX_NOTE_CHARS = 2000;

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
  /** The effort every turn runs with; low when absent. */
  effort?: Effort;
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

/** The scrubbed stderr a transport error carries, read without importing the transport. */
function stderrTailOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'stderrTail' in err && typeof err.stderrTail === 'string') {
    return err.stderrTail;
  }
  return undefined;
}

/**
 * Runs every case. The report holds counts and latency, no prompts or answers; the records hold
 * what each attempt did, and may hold answers, so they belong in the gitignored results folder.
 */
export async function runEval(opts: EvalOptions): Promise<{ report: EvalReport; records: CaseRecord[] }> {
  const runs = opts.runs ?? 1;
  const records: CaseRecord[] = [];
  const failing: string[] = [];
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
      const attemptRecords: AttemptRecord[] = [];
      const prompts: string[] = [];
      const transport: Transport = {
        async run(req, options) {
          const record: AttemptRecord = { attempt: attemptRecords.length === 0 ? 1 : 2, ms: 0 };
          attemptRecords.push(record);
          prompts.push(req.prompt);
          const began = performance.now();
          try {
            const out = await opts.transport.run(req, options);
            record.ms = Math.round(performance.now() - began);
            record.output = out.json;
            return out;
          } catch (err) {
            record.ms = Math.round(performance.now() - began);
            record.error = {
              kind: toAgentErrorKind(err, options.signal),
              message: (err instanceof Error ? err.message : 'unexpected error').slice(0, MAX_DETAIL_CHARS),
            };
            const stderrTail = stderrTailOf(err);
            if (stderrTail !== undefined) record.stderrTail = stderrTail;
            throw err;
          }
        },
      };
      const { done } = runTask(opts.task, c.input, {
        transport,
        provider: opts.provider,
        ...(opts.effort ? { effort: opts.effort } : {}),
        onEvent: (e) => {
          if (e.type === 'attempt') attempts++;
        },
        ...(validate
          ? {
              validate: async (result: unknown, ctx: { attempt: 1 | 2; signal?: AbortSignal }) => {
                const check = await validate(c.input, result, ctx);
                checks.set(ctx.attempt, check);
                const record = attemptRecords[ctx.attempt - 1];
                if (record) {
                  const { validation } = check;
                  record.check = {
                    ok: validation.ok,
                    ...(validation.ok ? {} : { message: validation.message.slice(0, MAX_DETAIL_CHARS) }),
                    ran: check.ran,
                    loops: check.loops,
                    maxFrameMs: check.maxFrameMs,
                  };
                }
                return check.validation;
              },
            }
          : {}),
      });
      const out = await done;
      const elapsed = performance.now() - start;
      latencies.push(elapsed);

      const passed = out.source === 'ai';
      const acceptedAttempt = passed ? attemptRecords.at(-1) : undefined;
      if (acceptedAttempt) Reflect.deleteProperty(acceptedAttempt, 'output');
      if (!passed && !failing.includes(c.id)) failing.push(c.id);
      const firstPrompt = prompts[0];
      const secondPrompt = prompts[1];
      records.push({
        id: c.id,
        run: i + 1,
        passed,
        ms: Math.round(elapsed),
        ...(out.notice
          ? {
              notice: {
                kind: out.notice.kind,
                ...(out.notice.detail === undefined ? {} : { detail: out.notice.detail.slice(0, MAX_DETAIL_CHARS) }),
              },
            }
          : {}),
        ...(firstPrompt !== undefined && secondPrompt !== undefined
          ? { retryNote: secondPrompt.slice(firstPrompt.length).trim().slice(0, MAX_NOTE_CHARS) }
          : {}),
        attempts: attemptRecords,
        ...(passed ? { result: out.result } : {}),
      });

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
  const report: EvalReport = {
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
    failing,
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
  return { report, records };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 1000;
}
