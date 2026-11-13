import { backgroundTask, type TaskEvent, type TaskResult } from '@cropa/ai';
import { builtinPresets, defaultScene, type BackgroundSpec } from '@cropa/core';
import { describe, expect, it, vi } from 'vitest';

import type { ModuleCheck } from '../code-sandbox/index.ts';
import {
  applyGenerated,
  backgroundRequest,
  backgroundValidator,
  backgroundWhileWaiting,
  checkSize,
  codeSourceOf,
  presetNameFrom,
  replaceCodeLayer,
} from './ai-background.ts';
import { createAiBackgroundSession, isRefining, type AiRunRequest } from './ai-background-session.ts';
import { historyReducer, initHistory, type HistoryAction } from './history.ts';
import { setBackgroundBlur } from './scene-edits.ts';

const preset = builtinPresets[0];
if (!preset) throw new Error('no built-in preset');

const withCode = (source = 'const meta = { durationMs: 4000 };') =>
  backgroundTask.postprocess({ source, durationMs: 4000, threeD: false }, {
    input: { description: 'x', palette: [], frame: { width: 1, height: 1, frame: { x: 0, y: 0, width: 1, height: 1, radius: 0, border: 0 } } },
  });

const scene = { width: 640, height: 360, palette: ['#112233'], frame: { x: 10, y: 10, width: 100, height: 100, radius: 4, border: 0 } };
const ran: ModuleCheck = { ok: true, loops: true, maxFrameMs: 4, durationMs: 4000 };

describe('checkSize and backgroundRequest', () => {
  it('uses the output size, scaled down to 1920 on the long side and never up', () => {
    const small = defaultScene({ width: 800, height: 600 });
    const size = checkSize(small);
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1920);

    const big = { ...defaultScene({ width: 4000, height: 3000 }), output: { aspectRatio: null, width: 8000 } };
    expect(checkSize(big)).toMatchObject({ width: 1920 });
    const input = backgroundRequest(big, '  fireflies  ', [{ hex: '#112233', weight: 1 }]);
    expect(input.input.description).toBe('fireflies');
  });

  it('gives the task and the check the same canvas and frame', () => {
    const s = defaultScene({ width: 1200, height: 800 });
    const palette = [{ hex: '#aa0000', weight: 0.6 }, { hex: '#00bb00', weight: 0.4 }];
    const { input, check } = backgroundRequest(s, 'rain', palette);
    expect(input.frame).toEqual({ width: check.width, height: check.height, frame: check.frame });
    expect(check.palette).toEqual(['#aa0000', '#00bb00']);
    expect(input.palette).toBe(palette);
  });
});

describe('backgroundValidator', () => {
  it('fails a spec without a code layer, without running anything', async () => {
    const check = vi.fn<() => Promise<ModuleCheck>>();
    const { validate } = backgroundValidator(scene, check);
    expect(await validate(preset.background)).toEqual({ ok: false, message: 'no code layer' });
    expect(check).not.toHaveBeenCalled();
  });

  it('runs the code layer source on the given scene and passes a module that ran and loops', async () => {
    const check = vi.fn(() => Promise.resolve(ran));
    const { validate, noWebgl } = backgroundValidator(scene, check);
    expect(await validate(withCode('const meta = { durationMs: 1234 };'))).toEqual({ ok: true });
    expect(check).toHaveBeenCalledWith('const meta = { durationMs: 1234 };', scene, {});
    const signal = new AbortController().signal;
    await validate(withCode(), { signal });
    expect(check).toHaveBeenLastCalledWith(expect.any(String), scene, { signal });
    expect(noWebgl()).toBe(false);
  });

  it('sends the sandbox message back for an error and for a loop that does not close', async () => {
    const slow: ModuleCheck = {
      ok: false,
      loops: false,
      maxFrameMs: 0,
      error: { kind: 'timeout', message: 'Rendering the frame at t=0 took longer than 250 ms.' },
    };
    const first = backgroundValidator(scene, () => Promise.resolve(slow));
    expect(await first.validate(withCode())).toEqual({ ok: false, message: slow.error?.message });

    const open = backgroundValidator(scene, () => Promise.resolve({ ...ran, loops: false }));
    const verdict = await open.validate(withCode());
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.message).toContain('loop does not close');
  });

  it('does not retry without WebGL, and remembers it for the notice', async () => {
    const check = vi.fn(() =>
      Promise.resolve<ModuleCheck>({
        ok: false,
        loops: false,
        maxFrameMs: 0,
        error: { kind: 'no-webgl', message: 'WebGL is not available here.' },
      }),
    );
    const { validate, noWebgl } = backgroundValidator(scene, check);
    expect(await validate(withCode())).toEqual({ ok: false, retry: false, message: 'WebGL is not available here.' });
    expect(noWebgl()).toBe(true);
  });
});

describe('backgroundWhileWaiting and applyGenerated', () => {
  const generated = withCode();
  const other = builtinPresets[1]?.background ?? preset.background;

  it('shows the closest preset while waiting, but keeps generated code that is already there', () => {
    expect(backgroundWhileWaiting(preset.background, other)).toBe(other);
    expect(backgroundWhileWaiting(generated, other)).toBe(generated);
  });

  it('applies the result when the background is still the one the run left', () => {
    const scene = { ...defaultScene({ width: 400, height: 300 }), background: preset.background };
    expect(applyGenerated(scene, preset.background, generated).background).toEqual(generated);
  });

  it('drops the result, returning the same scene, after a manual background edit', () => {
    const base = { ...defaultScene({ width: 400, height: 300 }), background: preset.background };
    const edited = setBackgroundBlur(base, 12);
    expect(edited.background).not.toEqual(preset.background);
    expect(applyGenerated(edited, preset.background, generated)).toBe(edited);
  });
});

describe('replaceCodeLayer and presetNameFrom', () => {
  it('swaps only the code layer and keeps the layers around it', () => {
    const current: BackgroundSpec = {
      ...preset.background,
      layers: [{ type: 'solid', color: '#abcdef' }, ...withCode('const meta = { durationMs: 1000 };').layers],
    };
    const result = withCode('const meta = { durationMs: 2000 };');
    const other = builtinPresets[1]?.background ?? preset.background;
    const next = replaceCodeLayer(current, result);
    expect(next.layers).toHaveLength(current.layers.length);
    expect(next.layers[0]).toEqual({ type: 'solid', color: '#abcdef' });
    expect(codeSourceOf(next)).toBe('const meta = { durationMs: 2000 };');
    expect(replaceCodeLayer(preset.background, other)).toBe(preset.background);
    expect(replaceCodeLayer({ ...preset.background, layers: [{ type: 'solid', color: '#000000' }] }, result)).toBe(result);
  });

  it('cuts a description on whole characters to the preset name limit, on one line', () => {
    expect(presetNameFrom('  fireflies\n over   a lake ')).toBe('fireflies over a lake');
    const long = presetNameFrom('é'.repeat(30) + '😀'.repeat(30));
    expect(Array.from(long)).toHaveLength(40);
    expect(presetNameFrom('   ')).toBe('');
  });
});

describe('AI background session', () => {
  const other = builtinPresets[1]?.background ?? preset.background;
  const srcA = 'const meta = { durationMs: 4001 };';
  const srcB = 'const meta = { durationMs: 4002 };';
  const done = (result: BackgroundSpec): TaskResult<BackgroundSpec> => ({ result, source: 'ai' });
  const failed = (kind: 'Timeout' | 'Cancelled'): TaskResult<BackgroundSpec> => ({
    result: other,
    source: 'fallback',
    notice: { kind },
  });
  const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

  const plain = preset.background;
  function setup(background: BackgroundSpec = plain) {
    let h = initHistory({ ...defaultScene({ width: 400, height: 300 }), background });
    const dispatch = (action: HistoryAction) => { h = historyReducer(h, action); };
    const requests: AiRunRequest[] = [];
    const resolvers: ((out: TaskResult<BackgroundSpec>) => void)[] = [];
    let latest = 0;
    const applied = vi.fn();
    const session = createAiBackgroundSession({
      start: (request) => {
        requests.push(request);
        return {
          fallback: other,
          done: new Promise((resolve) => { resolvers.push(resolve); }),
          noWebgl: () => false,
        };
      },
      history: {
        scene: () => h.present,
        preview: (change) => { dispatch({ type: 'preview', scene: (s) => change(s) }); },
        commit: () => { dispatch({ type: 'commit' }); },
      },
      beginBackgroundChange: () => {
        const mine = ++latest;
        return () => mine === latest;
      },
      onApplied: applied,
      now: () => 1000,
    });
    return {
      session,
      applied,
      requests,
      history: () => h,
      dispatch,
      /** Answers the newest run. */
      answer: async (out: TaskResult<BackgroundSpec>) => {
        resolvers.at(-1)?.(out);
        await flush();
      },
      event: (event: TaskEvent) => { requests.at(-1)?.onEvent(event); },
    };
  }

  const generate = (s: ReturnType<typeof setup>, description = 'rain') => {
    s.session.generate(description, [], 'mock', 'medium');
  };

  it('runs from writing to checking, applies the result and records who made it', async () => {
    const s = setup();
    generate(s);
    expect(s.session.getState().run).toMatchObject({ kind: 'generate', phase: 'writing', startedAt: 1000 });
    expect(s.requests[0]?.input.currentSource).toBeUndefined();
    // The closest preset shows while the AI works.
    expect(s.history().present.background).toBe(other);
    s.event({ type: 'validating', attempt: 1 });
    expect(s.session.getState().run?.phase).toBe('checking');
    s.event({ type: 'attempt', attempt: 2 });
    expect(s.session.getState().run?.phase).toBe('writing');

    await s.answer(done(withCode(srcA)));
    expect(s.session.getState()).toEqual({ run: null, notice: null, startedOverFrom: null });
    expect(codeSourceOf(s.history().present.background)).toBe(srcA);
    expect(s.session.infoFor(s.history().present)).toEqual({ description: 'rain', provider: 'mock', effort: 'medium' });
    expect(s.session.infoFor({ ...s.history().present, background: preset.background })).toBeUndefined();
  });

  it('announces an applied result once, and nothing for a fallback or a result dropped after an edit', async () => {
    const s = setup();
    generate(s);
    await s.answer(done(withCode(srcA)));
    expect(s.applied).toHaveBeenCalledTimes(1);

    s.session.regenerate([], 'mock', 'low');
    await s.answer(failed('Timeout'));
    expect(s.applied).toHaveBeenCalledTimes(1);

    s.session.regenerate([], 'mock', 'low');
    s.dispatch({ type: 'preview', scene: (scene) => ({ ...scene, background: plain }) });
    await s.answer(done(withCode(srcB)));
    expect(s.applied).toHaveBeenCalledTimes(1);
  });

  it('keeps the result on screen while regenerating, and after a failure or a cancel', async () => {
    const s = setup();
    generate(s, 'rain');
    await s.answer(done(withCode(srcA)));
    const shown = s.history().present.background;

    s.session.regenerate([], 'mock', 'high');
    expect(s.requests[1]?.input).toMatchObject({ description: 'rain' });
    expect(s.requests[1]?.input.currentSource).toBeUndefined();
    expect(s.history().present.background).toBe(shown);
    await s.answer(failed('Timeout'));
    expect(s.history().present.background).toBe(shown);
    expect(s.session.getState().notice).toEqual({ reason: 'Timeout', provider: 'mock', unchanged: true });

    s.session.regenerate([], 'mock', 'high');
    expect(s.session.getState().notice).toBeNull();
    s.session.cancel();
    await s.answer(failed('Cancelled'));
    expect(s.history().present.background).toBe(shown);
    expect(s.session.getState()).toEqual({ run: null, notice: null, startedOverFrom: null });
  });

  it('does nothing to regenerate or refine without something to work from', () => {
    const s = setup();
    s.session.regenerate([], 'mock', 'low');
    s.session.refine('more wind', [], 'mock', 'low');
    s.session.generate('   ', [], 'mock', 'low');
    expect(s.requests).toHaveLength(0);
  });

  it('refines the scene code, keeps its other layers, and keeps the original description', async () => {
    const start: BackgroundSpec = {
      ...preset.background,
      layers: [{ type: 'solid', color: '#abcdef' }, ...withCode(srcA).layers],
    };
    const s = setup(start);
    s.session.refine('  more wind ', [], 'claude', 'low');
    expect(s.requests[0]?.input).toMatchObject({ description: 'more wind', currentSource: srcA });
    expect(s.history().present.background).toBe(start);

    await s.answer(done(withCode(srcB)));
    const applied = s.history().present.background;
    expect(applied.layers).toHaveLength(start.layers.length);
    expect(applied.layers[0]).toEqual({ type: 'solid', color: '#abcdef' });
    expect(codeSourceOf(applied)).toBe(srcB);
    // The scene's code was not made in this session, so the change is the best description there is.
    expect(s.session.infoFor(s.history().present)?.description).toBe('more wind');

    const t = setup();
    generate(t, 'fireflies');
    await t.answer(done(withCode(srcA)));
    t.session.refine('make it night', [], 'mock', 'low');
    await t.answer(done(withCode(srcB)));
    expect(t.session.infoFor(t.history().present)?.description).toBe('fireflies');
  });

  it('starts over to a fresh description, and a new result or another module brings the refine view back', async () => {
    const s = setup();
    const refining = () => isRefining(s.session.getState(), s.history().present);
    generate(s);
    await s.answer(done(withCode(srcA)));
    expect(refining()).toBe(true);
    s.session.startOver();
    expect(refining()).toBe(false);
    generate(s, 'snow');
    expect(s.requests[1]?.input.currentSource).toBeUndefined();
    expect(refining()).toBe(false);
    await s.answer(done(withCode(srcB)));
    expect(refining()).toBe(true);

    // Starting over from B and then undoing to A shows A for refining.
    s.session.startOver();
    expect(refining()).toBe(false);
    s.dispatch({ type: 'undo' });
    expect(codeSourceOf(s.history().present.background)).toBe(srcA);
    expect(refining()).toBe(true);
  });

  it('drops a result when the background was edited meanwhile, with no step from the run', async () => {
    const s = setup();
    generate(s);
    s.dispatch({ type: 'edit', scene: (scene) => setBackgroundBlur(scene, 12) });
    const edited = s.history().present.background;
    await s.answer(done(withCode(srcA)));
    expect(s.history().present.background).toBe(edited);
    const { past, present } = s.history();
    expect([...past, present].some((scene) => codeSourceOf(scene.background) !== undefined)).toBe(false);
    expect(s.session.getState().notice).toBeNull();
  });

  it('keeps the preset that stayed on screen after a failure as a normal undo step', async () => {
    const s = setup();
    generate(s);
    await s.answer(failed('Timeout'));
    expect(s.history().present.background).toBe(other);
    expect(s.history().base).toBeNull();
    expect(s.history().past.map((scene) => scene.background)).toEqual([preset.background]);
    expect(s.session.getState().notice).toEqual({ reason: 'Timeout', provider: 'mock', unchanged: false });
  });

  it('makes one undo step per result: plain, A, B, and back', async () => {
    const s = setup();
    generate(s);
    await s.answer(done(withCode(srcA)));
    // The preset shown while waiting is not a step of its own.
    expect(s.history().past.map((scene) => scene.background)).toEqual([preset.background]);
    generate(s, 'again');
    await s.answer(done(withCode(srcB)));
    expect(s.history().past).toHaveLength(2);

    const source = () => codeSourceOf(s.history().present.background);
    expect(source()).toBe(srcB);
    s.dispatch({ type: 'undo' });
    expect(source()).toBe(srcA);
    expect(s.session.infoFor(s.history().present)?.description).toBe('rain');
    s.dispatch({ type: 'undo' });
    expect(s.history().present.background).toEqual(preset.background);
    s.dispatch({ type: 'redo' });
    s.dispatch({ type: 'redo' });
    expect(source()).toBe(srcB);
    expect(s.session.infoFor(s.history().present)?.description).toBe('again');
  });
});
