// Renders the frames of the background modules an eval run accepted, and draws a contact sheet.
//
//   pnpm --filter @cropa/ai frames <a.cases.json> [<b.cases.json> ...]
//
// The Node checker only records draw calls, so it has no pixels. This renders them in a headless
// Edge or Chrome, in the same sandbox the app uses (a sandboxed iframe, a blob Worker, the real
// worker runtime and the same three.js bundle), with a placeholder screenshot card on top of the
// back layer and the front layer over it. See evals/browser.ts and evals/frames-page.js.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { bundleThreeIife } from '../../../apps/desktop/three-bundle.ts';
import { sandboxDocument } from '../../../apps/desktop/src/features/code-sandbox/bootstrap.ts';
import { composeWorkerSource, usesThree } from '../../../apps/desktop/src/features/code-sandbox/compose-worker.ts';
import type { BackgroundInput } from '../src/tasks/background.ts';
import { launchBrowser } from './browser.ts';
import type { EvalBrowser } from './browser.ts';
import type { EvalCase } from './eval.ts';
import { checkScene, EVAL_TASKS, loadCases } from './registry.ts';
import type { NodeScene } from './node-check.ts';

const RecordsFile = z.object({
  task: z.string(),
  version: z.number(),
  provider: z.string(),
  records: z.array(
    z.object({ id: z.string(), run: z.number(), passed: z.boolean(), result: z.unknown().optional() }).loose(),
  ),
});

const SAMPLE_NAMES = ['t0', 't033', 't066'];

interface RenderJob {
  key: string;
  html: string;
  code: string;
  scene: NodeScene;
}

type RenderReply = { ok: true; pngs: string[]; ms: number[] } | { ok: false; error: string };

/** What happened to one case in one records file. */
export interface FrameOutcome {
  id: string;
  group: number;
  status: 'rendered' | 'fallback' | 'error';
  /** The slowest of the three frames, in milliseconds, when rendered. */
  maxMs?: number;
  /** The frame times in milliseconds, when rendered. */
  ms?: number[];
  /** Why rendering failed, when it did. */
  error?: string;
}

export interface FramesResult {
  sheet: string;
  frameDirs: string[];
  outcomes: FrameOutcome[];
}

const PAGE = readFileSync(new URL('./frames-page.js', import.meta.url), 'utf8');
const RUNTIME = readFileSync(
  new URL('../../../apps/desktop/src/features/code-sandbox/worker-runtime.js', import.meta.url),
  'utf8',
);

/** The records file's name without its extension. */
function baseOf(file: string): string {
  return basename(file).replace(/\.cases\.json$/, '').replace(/\.json$/, '');
}

function pngBytes(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

function codeSource(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || !('layers' in result) || !Array.isArray(result.layers)) return undefined;
  for (const layer of result.layers as unknown[]) {
    if (typeof layer === 'object' && layer !== null && 'type' in layer && layer.type === 'code' && 'source' in layer) {
      return typeof layer.source === 'string' ? layer.source : undefined;
    }
  }
  return undefined;
}

/** The registry entry whose cases hold every id in the file, for the task the file names. */
function entryFor(task: string, ids: readonly string[]): { cases: EvalCase[] } {
  for (const entry of Object.values(EVAL_TASKS)) {
    if (entry.task.id !== task) continue;
    const cases = loadCases(entry.cases, entry.task.id);
    const known = new Set(cases.map((c) => c.id));
    if (ids.every((id) => known.has(id))) return { cases };
  }
  throw new Error(`No eval case set for task ${task} holds every case id of the records file.`);
}

/**
 * Renders the passed cases of one or more records files and writes the frames and the contact
 * sheet. One file gives `<base>.sheet.png`; several give `compare-<stamp>.sheet.png` with one
 * column group per file. Starts its own headless browser unless one is passed.
 */
export async function renderFrames(files: readonly string[], options: { browser?: EvalBrowser } = {}): Promise<FramesResult> {
  if (files.length === 0) throw new Error('Give at least one records file (*.cases.json).');
  const inputs = files.map((file) => {
    const parsed = RecordsFile.parse(JSON.parse(readFileSync(file, 'utf8')));
    const firstRuns = new Map<string, (typeof parsed.records)[number]>();
    for (const record of parsed.records) if (!firstRuns.has(record.id)) firstRuns.set(record.id, record);
    return { file, ...parsed, firstRuns };
  });

  // Rows follow the order of the cases file; the case sets of the inputs may differ.
  const ids = new Set(inputs.flatMap((input) => [...input.firstRuns.keys()]));
  const allCases = new Map<string, EvalCase>();
  const order: string[] = [];
  for (const input of inputs) {
    for (const c of entryFor(input.task, [...input.firstRuns.keys()]).cases) {
      if (ids.has(c.id) && !allCases.has(c.id)) {
        allCases.set(c.id, c);
        order.push(c.id);
      }
    }
  }

  const ownBrowser = options.browser === undefined;
  const browser = options.browser ?? (await launchBrowser());
  const outcomes: FrameOutcome[] = [];
  const frameDirs: string[] = [];
  try {
    await browser.evaluate<string>(PAGE);
    const html = sandboxDocument();
    let three: string | null = null;

    for (const [group, input] of inputs.entries()) {
      const root = join(dirname(input.file), 'frames');
      let dir = join(root, baseOf(input.file));
      // Two inputs with the same name must not overwrite each other's frames.
      for (let n = 2; frameDirs.includes(dir); n++) dir = join(root, `${baseOf(input.file)}-${String(n)}`);
      mkdirSync(dir, { recursive: true });
      frameDirs.push(dir);
      for (const id of order) {
        const record = input.firstRuns.get(id);
        const c = allCases.get(id);
        if (!record || !c) continue;
        if (!record.passed) {
          outcomes.push({ id, group, status: 'fallback' });
          continue;
        }
        const fail = (error: string): void => {
          outcomes.push({ id, group, status: 'error', error });
        };
        const source = codeSource(record.result);
        if (source === undefined) {
          fail('The record holds no code layer; run the eval again so it keeps the accepted answer.');
          continue;
        }
        let code: string;
        try {
          if (usesThree(source)) three ??= await bundleThreeIife();
          code = composeWorkerSource(RUNTIME, source, usesThree(source) ? three : null);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
          continue;
        }
        const job: RenderJob = { key: `${String(group)}/${id}`, html, code, scene: checkScene(c.input as BackgroundInput) };
        const reply = await browser.evaluate<RenderReply>(`globalThis.__cropaFrames.renderCase(${JSON.stringify(job)})`);
        if (!reply.ok) {
          fail(reply.error);
          continue;
        }
        reply.pngs.forEach((png, i) => {
          writeFileSync(join(dir, `${id}-${SAMPLE_NAMES[i] ?? String(i)}.png`), pngBytes(png));
        });
        outcomes.push({ id, group, status: 'rendered', ms: reply.ms, maxMs: Math.max(...reply.ms) });
      }
    }

    const layout = {
      groups: inputs.map((input) => ({ label: `${input.provider} v${String(input.version)} ${baseOf(input.file)}` })),
      rows: order.map((id) => {
        const c = allCases.get(id);
        const scene = checkScene(c?.input as BackgroundInput);
        const description = (c?.input as BackgroundInput | undefined)?.description ?? '';
        return {
          id,
          description,
          width: scene.width,
          height: scene.height,
          cells: inputs.map((_input, group) => {
            const outcome = outcomes.find((o) => o.id === id && o.group === group);
            if (!outcome) return { key: null, status: 'not run', fallback: false };
            if (outcome.status === 'fallback') return { key: null, status: 'fallback', fallback: true };
            if (outcome.status === 'error') return { key: null, status: outcome.error ?? 'render failed', fallback: true };
            return { key: `${String(group)}/${id}`, status: `max ${String(Math.round(outcome.maxMs ?? 0))} ms (headless)`, fallback: false };
          }),
        };
      }),
    };
    const sheetUrl = await browser.evaluate<string>(`globalThis.__cropaFrames.sheet(${JSON.stringify(layout)})`);
    const first = inputs[0];
    if (!first) throw new Error('unreachable');
    const sheetName =
      inputs.length === 1
        ? `${baseOf(first.file)}.sheet.png`
        : `compare-${new Date().toISOString().replace(/[:.]/g, '-')}.sheet.png`;
    const sheet = join(dirname(first.file), sheetName);
    writeFileSync(sheet, pngBytes(sheetUrl));
    return { sheet, frameDirs, outcomes };
  } finally {
    if (ownBrowser) await browser.close();
  }
}

/** A short report of a run, for the terminal. */
export function describeOutcomes(result: FramesResult): string[] {
  const lines = result.outcomes.map((o) => {
    const detail =
      o.status === 'rendered' ? `frames ${(o.ms ?? []).map((ms) => `${String(ms)} ms`).join(', ')}` : (o.error ?? o.status);
    return `  [${String(o.group + 1)}] ${o.id}: ${o.status} (${detail})`;
  });
  return [...lines, `sheet:  ${result.sheet}`, ...result.frameDirs.map((dir) => `frames: ${dir}`)];
}

if (import.meta.main) {
  const files = process.argv.slice(2).map((file) => resolve(file));
  if (files.length === 0 || files.includes('--help')) {
    console.log(`Usage: pnpm --filter @cropa/ai frames <a.cases.json> [<b.cases.json> ...]

Renders the accepted background modules of eval runs in a headless Edge or Chrome (set
CROPA_EVAL_BROWSER to a Chromium executable if none is found) and writes the frames and a contact
sheet next to the records files, under evals/results/ (gitignored). With several files the sheet
shows them side by side.`);
    process.exit(files.length === 0 ? 1 : 0);
  }
  const result = await renderFrames(files);
  for (const line of describeOutcomes(result)) console.log(line);
}
