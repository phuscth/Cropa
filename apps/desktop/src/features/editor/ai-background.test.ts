import { backgroundTask } from '@cropa/ai';
import { builtinPresets, defaultScene } from '@cropa/core';
import { describe, expect, it, vi } from 'vitest';

import type { ModuleCheck } from '../code-sandbox/index.ts';
import {
  applyGenerated,
  backgroundRequest,
  backgroundValidator,
  backgroundWhileWaiting,
  checkSize,
} from './ai-background.ts';
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
