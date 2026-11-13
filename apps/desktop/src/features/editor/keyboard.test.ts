import { describe, expect, it } from 'vitest';

import { toolForKey } from './annotate/tools.ts';
import { keyLetter } from './keyboard.ts';

const press = (key: string, code: string) => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
});

describe('keyLetter', () => {
  it('prefers the character the layout produces', () => {
    expect(keyLetter({ key: 'p', code: 'KeyR' })).toBe('p');
    expect(keyLetter({ key: 'P', code: 'KeyR' })).toBe('p');
  });

  it('falls back to the physical key for a character that is not a Latin letter', () => {
    expect(keyLetter({ key: 'к', code: 'KeyR' })).toBe('r');
    expect(keyLetter({ key: 'Process', code: 'KeyA' })).toBe('a');
    expect(keyLetter({ key: '1', code: 'Digit1' })).toBeNull();
  });
});

describe('toolForKey', () => {
  it('follows the layout on a Dvorak-like keyboard', () => {
    expect(toolForKey(press('p', 'KeyR'))).toBe('pixelate');
  });

  it('uses the physical key on a Cyrillic layout', () => {
    expect(toolForKey(press('к', 'KeyR'))).toBe('rect');
  });

  it('ignores a key with a modifier', () => {
    expect(toolForKey({ ...press('a', 'KeyA'), ctrlKey: true })).toBeNull();
  });
});
