import { BUILTIN_IMAGES } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import {
  beginBackgroundChange,
  builtinAssetNames,
  builtinUrl,
  cacheImage,
  imageBitmap,
  releaseMasksExcept,
} from './background-images.ts';

describe('built-in background images', () => {
  it('has a file for every name core lists, and none core does not list', () => {
    expect(builtinAssetNames().sort()).toEqual([...BUILTIN_IMAGES].sort());
    for (const name of BUILTIN_IMAGES) expect(builtinUrl(name)).toEqual(expect.any(String));
  });
});

describe('cut-out bitmaps', () => {
  const fake = () => {
    const state = { closed: false };
    const bitmap = { close: () => { state.closed = true; } } as unknown as ImageBitmap;
    return { bitmap, state };
  };

  it('keeps the current image\'s cut-outs and closes the others', () => {
    const old = fake();
    const current = fake();
    const user = fake();
    cacheImage('mask:4-1', old.bitmap);
    cacheImage('mask:5-1', current.bitmap);
    cacheImage('user:photo', user.bitmap);

    releaseMasksExcept('5');

    expect(old.state.closed).toBe(true);
    expect(imageBitmap('mask:4-1')).toBeUndefined();
    expect(current.state.closed).toBe(false);
    expect(imageBitmap('mask:5-1')).toBe(current.bitmap);
    expect(user.state.closed).toBe(false);

    releaseMasksExcept(null);
    expect(current.state.closed).toBe(true);
    expect(imageBitmap('user:photo')).toBe(user.bitmap);
  });

  it('does not take a longer key for the same image', () => {
    const other = fake();
    cacheImage('mask:55-1', other.bitmap);
    releaseMasksExcept('5');
    expect(other.state.closed).toBe(true);
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
