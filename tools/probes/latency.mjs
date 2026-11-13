// Cold latency of one locked-down, schema-constrained turn, run N times in a
// row, each in a fresh empty temp folder.
//
//   node tools/probes/latency.mjs codex|claude [runs=5] [--minimal]
//
// --minimal (Codex only) uses the shorter flag set without the disabled features.

import fs from 'node:fs';
import path from 'node:path';

import {
  BACKGROUND_SCHEMA,
  BACKGROUND_SYSTEM,
  BACKGROUND_USER,
  CODEX_MINIMAL,
  OUT_DIR,
  cliFromArgv,
  percentile,
  removeDir,
  tempDir,
} from './lib.mjs';
import { turn } from './turn.mjs';

const cli = cliFromArgv();
const minimal = process.argv.includes('--minimal');
const runs = Number(process.argv.slice(3).find((a) => !a.startsWith('--')) ?? 5);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
  console.error('Runs must be between 1 and 10: every run spends real quota.');
  process.exit(2);
}

const rows = [];
for (let i = 1; i <= runs; i++) {
  const cwd = tempDir(`latency-${cli}`);
  try {
    const r = await turn(cli, {
      label: `latency-${cli}${minimal ? '-minimal' : ''}-${i}`,
      cwd,
      args: minimal && cli === 'codex' ? CODEX_MINIMAL : undefined,
      system: BACKGROUND_SYSTEM,
      user: BACKGROUND_USER,
      schema: BACKGROUND_SCHEMA,
    });
    const valid = r.answer?.structured !== undefined && !r.answer?.isError;
    rows.push({ run: i, firstEventMs: r.firstEventMs, finalMs: r.finalMs, exitMs: r.exitMs, exitCode: r.exitCode, valid });
    console.log(
      `run ${i}: first event ${r.firstEventMs} ms, final event ${r.finalMs} ms, exit ${r.exitMs} ms, code ${r.exitCode}, valid JSON ${valid}`,
    );
  } finally {
    removeDir(cwd);
  }
}

const stat = (key) => {
  const values = rows.map((r) => r[key]).filter((v) => typeof v === 'number');
  const missing = rows.length - values.length;
  if (missing) console.warn(`${key}: ${missing} of ${rows.length} runs have no value and are left out.`);
  if (!values.length) return { n: 0, missing };
  return {
    n: values.length,
    missing,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
};
const summary = { cli, minimal, runs, firstEventMs: stat('firstEventMs'), finalMs: stat('finalMs'), exitMs: stat('exitMs'), rows };
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(OUT_DIR, `latency-${cli}${minimal ? '-minimal' : ''}-summary-${Date.now()}.json`), JSON.stringify(summary, null, 2));
