import { describe, expect, it } from 'vitest';

import { presetFileProblem } from './preset-file.ts';

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
