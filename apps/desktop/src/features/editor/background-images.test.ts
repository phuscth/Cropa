import { BUILTIN_IMAGES } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import { beginBackgroundChange, builtinAssetNames, builtinUrl } from './background-images.ts';

describe('built-in background images', () => {
  it('has a file for every name core lists, and none core does not list', () => {
    expect(builtinAssetNames().sort()).toEqual([...BUILTIN_IMAGES].sort());
    for (const name of BUILTIN_IMAGES) expect(builtinUrl(name)).toEqual(expect.any(String));
  });
});

describe('background change requests', () => {
  it('lets only the newest request go on', () => {
    const first = beginBackgroundChange();
    expect(first()).toBe(true);
    const second = beginBackgroundChange();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
