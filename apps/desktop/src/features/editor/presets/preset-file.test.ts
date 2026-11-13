import { builtinPresets } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import { isAiPreset, presetFileProblem } from './preset-file.ts';

describe('presetFileProblem', () => {
  it('maps every kind of preset error', () => {
    expect(presetFileProblem({ kind: 'too-large', bytes: 20000, limit: 16384 })).toEqual({
      kind: 'PresetFileTooLarge',
      limitKb: 16,
    });
    expect(presetFileProblem({ kind: 'not-json' })).toEqual({ kind: 'PresetFileNotJson' });
    expect(presetFileProblem({ kind: 'too-new', version: 9, supported: 1 })).toEqual({
      kind: 'PresetFileTooNew',
    });
    expect(presetFileProblem({ kind: 'has-code' })).toEqual({ kind: 'PresetFileHasCode' });
  });

  it('keeps at most three issues', () => {
    const problem = presetFileProblem({ kind: 'invalid', issues: ['a', 'b', 'c', 'd'] });
    expect(problem).toEqual({ kind: 'PresetFileInvalid', detail: 'a; b; c' });
  });
});

describe('isAiPreset', () => {
  it('is true for a background with a code layer and false for every built-in preset', () => {
    const first = builtinPresets[0];
    if (!first) throw new Error('no built-in preset');
    const code = { type: 'code' as const, source: 'const meta = { durationMs: 4000 };', durationMs: 4000, threeD: false };
    expect(isAiPreset({ ...first.background, layers: [...first.background.layers, code] })).toBe(true);
    expect(builtinPresets.some((preset) => isAiPreset(preset.background))).toBe(false);
  });
});
