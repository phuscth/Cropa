import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import type { Provider } from '../src/task.ts';
import type { Transport } from '../src/transport.ts';
import { buildTurnBinary, createAgentTransport } from './agent-transport.ts';
import type { RealProvider } from './agent-transport.ts';
import { runEval } from './eval.ts';
import { EVAL_TASKS, loadCases } from './registry.ts';

const PROVIDERS = ['mock', 'codex', 'claude'];

const HELP = `Usage: pnpm --filter @cropa/ai eval --task <task> --provider <provider> [options]

  --task      ${Object.keys(EVAL_TASKS).join(' | ')}
  --provider  mock    scripted answers, no CLI, free (what the tests use)
              codex   one real turn per case through the Codex CLI you are logged in to
              claude  one real turn per case through the Claude Code CLI you are logged in to
  --limit N   run only the first N cases
  --cases a,b run only the cases with these ids
  --effort    low (default) | medium | high: how much thinking each real turn may spend

Real providers spend your own quota and take minutes: run them by hand, never in CI. The
first real run builds crates/cropa-agent/examples/turn.rs with cargo.

Every answer is code written by a model, and the eval runs it to check it. That happens in a
child Node process under the permission model (read-only access to the checker's own files, no
file writes, no child processes, no workers, an empty environment), killed on a time limit. The
module runs in a vm context with no host objects and no string code generation. The process does
NOT block the network (Node 24 has no flag for it); that context isolation is the barrier.`;

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    task: { type: 'string' },
    provider: { type: 'string' },
    limit: { type: 'string' },
    cases: { type: 'string' },
    effort: { type: 'string' },
    help: { type: 'boolean' },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (!values.task || !(values.task in EVAL_TASKS)) {
  fail(`Missing or unknown --task. Valid tasks: ${Object.keys(EVAL_TASKS).join(', ')}\n\n${HELP}`);
}
if (!values.provider || !PROVIDERS.includes(values.provider)) {
  fail(`Missing or unknown --provider. Valid providers: ${PROVIDERS.join(', ')}\n\n${HELP}`);
}

const entry = EVAL_TASKS[values.task];
if (!entry) fail(`Unknown task ${values.task}`);

let cases = loadCases(entry.cases, entry.task.id);
if (values.cases !== undefined) {
  const wanted = new Set(values.cases.split(',').map((id) => id.trim()));
  cases = cases.filter((c) => wanted.has(c.id));
  if (cases.length === 0) fail(`No case matches --cases ${values.cases}`);
}
if (values.limit !== undefined) {
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) fail('--limit must be a positive integer');
  cases = cases.slice(0, limit);
}

const efforts = ['low', 'medium', 'high'] as const;
const effort = efforts.find((level) => level === (values.effort ?? 'low'));
if (!effort) fail(`--effort must be one of: ${efforts.join(', ')}`);

const transport: Transport =
  values.provider === 'mock'
    ? entry.mock()
    : createAgentTransport(values.provider as RealProvider, buildTurnBinary());

const provider: Provider = { name: values.provider, capabilities: [] };
const { report, records } = await runEval({
  task: entry.task,
  cases,
  transport,
  provider,
  effort,
  ...(entry.validate ? { validate: entry.validate } : {}),
});

const v = report.validation;
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
if (v) {
  console.table([
    {
      runnableFirstTry: v.runnableFirstTry,
      runnableAfterRetry: v.runnableAfterRetry,
      loopClosedFirstTry: v.loopClosedFirstTry,
      loopClosedAfterRetry: v.loopClosedAfterRetry,
      maxFrameMs: v.maxFrameMs,
      p95FrameMs: v.p95FrameMs,
    },
  ]);
}
console.log('notices:', JSON.stringify(report.notices));
if (report.failing.length > 0) console.log('failing:', report.failing.join(', '));

// The records can hold answers and a scrubbed stderr tail, so they only go to the gitignored
// results folder.
const dir = new URL('results/', import.meta.url);
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const base = `${report.task}-v${String(report.version)}-${report.provider}-${stamp}`;
writeFileSync(new URL(`${base}.json`, dir), `${JSON.stringify(report, null, 2)}\n`);
const casesName = `${base}.cases.json`;
writeFileSync(
  new URL(casesName, dir),
  `${JSON.stringify({ task: report.task, version: report.version, provider: report.provider, records }, null, 2)}\n`,
);
console.log(`report: packages/ai/evals/results/${base}.json`);
console.log(`cases:  packages/ai/evals/results/${casesName}`);
