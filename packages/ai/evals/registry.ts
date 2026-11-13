import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { MockTransport } from '../src/mock-transport.ts';
import type { MockStep } from '../src/mock-transport.ts';
import { BACKGROUND_EXAMPLES, backgroundTask, judgeModuleCheck } from '../src/tasks/background.ts';
import type { BackgroundInput } from '../src/tasks/background.ts';
import { paletteNameTask } from '../src/tasks/palette-name.ts';
import type { Task } from '../src/task.ts';
import type { Transport } from '../src/transport.ts';
import type { EvalCase, EvalCheck } from './eval.ts';
import { checkModuleInNode } from './node-check.ts';
import type { NodeScene } from './node-check.ts';

const CasesFile = z.object({
  task: z.string(),
  cases: z.array(z.object({ id: z.string(), input: z.unknown() })),
});

export interface EvalTask {
  // The eval handles tasks of any input and output type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task: Task<any, any, any>;
  cases: string;
  /** A scripted transport: valid answers, a small fixed delay, a bad first answer for every fourth case. */
  mock: () => Transport;
  /** Checks an answer the way the app does. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  validate?: (input: any, result: any, ctx: { attempt: 1 | 2; signal?: AbortSignal }) => Promise<EvalCheck>;
}

export function loadCases(file: string, taskId: string): EvalCase[] {
  const parsed = CasesFile.parse(JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')));
  if (parsed.task !== taskId) throw new Error(`Cases file is for task ${parsed.task}, not ${taskId}`);
  return parsed.cases;
}

/**
 * Scripts a transport by case. A retry repeats the first prompt followed by a note, so the first
 * paragraph identifies the case; `answer` gets the case index and which attempt this is.
 */
function scripted(answer: (index: number, attempt: number) => MockStep): Transport {
  const order = new Map<string, number>();
  const attempts = new Map<number, number>();
  return new MockTransport((req): MockStep => {
    const key = req.prompt.split('\n\n')[0] ?? '';
    if (!order.has(key)) order.set(key, order.size);
    const index = order.get(key) ?? 0;
    const seen = (attempts.get(index) ?? 0) + 1;
    attempts.set(index, seen);
    return answer(index, seen);
  });
}

function paletteNameMock(): Transport {
  return scripted((index, attempt) => {
    const delayMs = 5 + (index % 3) * 4;
    if (index % 4 === 3 && attempt === 1) return { json: { name: 7 }, delayMs };
    return { json: { name: `Eval Palette ${String(index + 1)}`, mood: 'calm' }, delayMs };
  });
}

/** Moves with t * 1.5, so the frame at t=1 is not the frame at t=0. */
const BROKEN_MODULE = `const meta = { durationMs: 4000 };
function back(ctx, t, scene) {
  ctx.fillStyle = scene.palette[0] ?? '#000000';
  ctx.fillRect(0, 0, scene.width, scene.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(t * 1.5 * scene.width, scene.height / 2, scene.width / 20, scene.width / 20);
}`;

function backgroundMock(): Transport {
  return scripted((index, attempt) => {
    const delayMs = 5 + (index % 3) * 4;
    if (index % 4 === 3 && attempt === 1) {
      return { json: { source: BROKEN_MODULE, durationMs: 4000, threeD: false }, delayMs };
    }
    const example = BACKGROUND_EXAMPLES[index % BACKGROUND_EXAMPLES.length];
    if (!example) throw new Error('no background examples');
    const { source, durationMs, threeD } = example;
    return { json: { source, durationMs, threeD }, delayMs };
  });
}

const MAX_CHECK_SIDE = 1920;

/** The scene a case is checked on: the case's canvas and frame, at most 1920 px on the long side. */
export function checkScene(input: BackgroundInput): NodeScene {
  const { width, height, frame } = input.frame;
  const s = Math.min(1, MAX_CHECK_SIDE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * s)),
    height: Math.max(1, Math.round(height * s)),
    palette: input.palette.map((c) => c.hex),
    frame: {
      x: frame.x * s,
      y: frame.y * s,
      width: frame.width * s,
      height: frame.height * s,
      radius: frame.radius * s,
      border: frame.border * s,
    },
  };
}

async function validateBackground(
  input: BackgroundInput,
  result: { layers: { type: string; source?: string }[] },
): Promise<EvalCheck> {
  const layer = result.layers.find((l) => l.type === 'code');
  if (layer?.source === undefined) {
    return { validation: { ok: false, message: 'no code layer' }, ran: false, loops: false, maxFrameMs: 0 };
  }
  const check = await checkModuleInNode(layer.source, checkScene(input));
  return {
    validation: judgeModuleCheck(check),
    ran: check.ok,
    loops: check.ok && check.loops,
    maxFrameMs: check.maxFrameMs,
  };
}

export const EVAL_TASKS: Record<string, EvalTask> = {
  'palette-name': {
    task: paletteNameTask,
    cases: 'cases/palette-name.json',
    mock: paletteNameMock,
  },
  background: {
    task: backgroundTask,
    cases: 'cases/background.json',
    mock: backgroundMock,
    validate: validateBackground,
  },
  'background-refine': {
    task: backgroundTask,
    cases: 'cases/background-refine.json',
    mock: backgroundMock,
    validate: validateBackground,
  },
};
