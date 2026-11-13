import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { MockTransport } from '../src/mock-transport.ts';
import type { MockStep } from '../src/mock-transport.ts';
import { paletteNameTask } from '../src/tasks/palette-name.ts';
import type { Provider } from '../src/task.ts';
import type { Transport } from '../src/transport.ts';
import { runEval } from './eval.ts';

const CasesFile = z.object({
  task: z.string(),
  cases: z.array(z.object({ id: z.string(), input: z.unknown() })),
});

const TASKS = {
  'palette-name': { task: paletteNameTask, cases: 'cases/palette-name.json' },
};

// Until the desktop transport exists, only the scripted one can run.
const PROVIDERS = ['mock'];

/** Valid answers, a small fixed delay, and a bad first answer for every fourth case. */
function mockTransport(): Transport {
  // A retry repeats the first prompt followed by a note, so the first
  // paragraph identifies the case.
  const order = new Map<string, number>();
  const attempts = new Map<number, number>();
  return new MockTransport((req): MockStep => {
    const key = req.prompt.split('\n\n')[0] ?? '';
    if (!order.has(key)) order.set(key, order.size);
    const index = order.get(key) ?? 0;
    const seen = (attempts.get(index) ?? 0) + 1;
    attempts.set(index, seen);
    const delayMs = 5 + (index % 3) * 4;
    if (index % 4 === 3 && seen === 1) return { json: { name: 7 }, delayMs };
    return { json: { name: `Eval Palette ${String(index + 1)}`, mood: 'calm' }, delayMs };
  });
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({
  options: { task: { type: 'string' }, provider: { type: 'string' } },
});

const taskIds = Object.keys(TASKS);
if (!values.task || !(values.task in TASKS)) {
  fail(`Missing or unknown --task. Valid tasks: ${taskIds.join(', ')}`);
}
if (!values.provider || !PROVIDERS.includes(values.provider)) {
  fail(
    `Missing or unknown --provider. Valid providers: ${PROVIDERS.join(', ')} ` +
      '(real providers arrive with the desktop transport)',
  );
}

const entry = TASKS[values.task as keyof typeof TASKS];
const file = CasesFile.parse(
  JSON.parse(readFileSync(new URL(entry.cases, import.meta.url), 'utf8')),
);
if (file.task !== entry.task.id) fail(`Cases file is for task ${file.task}, not ${entry.task.id}`);

const provider: Provider = { name: values.provider, capabilities: [] };
const report = await runEval({
  task: entry.task,
  cases: file.cases,
  transport: mockTransport(),
  provider,
});

console.table([
  {
    task: report.task,
    version: report.version,
    provider: report.provider,
    cases: report.cases,
    validFirstTry: report.validFirstTry,
    validAfterRetry: report.validAfterRetry,
    firstTry: pct(report.validFirstTryRate),
    afterRetry: pct(report.validAfterRetryRate),
    p50Ms: report.p50Ms,
    p95Ms: report.p95Ms,
  },
]);
console.log('notices:', JSON.stringify(report.notices));

const dir = new URL('results/', import.meta.url);
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const name = `${report.task}-v${String(report.version)}-${report.provider}-${stamp}.json`;
writeFileSync(new URL(name, dir), `${JSON.stringify(report, null, 2)}\n`);
console.log(`report: packages/ai/evals/results/${name}`);
