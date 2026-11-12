import { describe, expect, it } from 'vitest';

import { recordAccelerator, type KeyLike } from './accelerator.ts';

const key = (code: string, mods: Partial<Omit<KeyLike, 'code'>> = {}): KeyLike => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('recordAccelerator', () => {
  it('records the default capture shortcut', () => {
    expect(recordAccelerator(key('KeyS', { altKey: true, shiftKey: true }))).toEqual({
      kind: 'done',
      accelerator: 'Alt+Shift+S',
    });
  });

  it('uses a fixed modifier order', () => {
    const result = recordAccelerator(
      key('Digit2', { shiftKey: true, ctrlKey: true, metaKey: true, altKey: true }),
    );
    expect(result).toEqual({ kind: 'done', accelerator: 'Ctrl+Alt+Shift+Super+2' });
  });

  it('keeps non-letter codes as is', () => {
    expect(recordAccelerator(key('F12', { ctrlKey: true }))).toEqual({
      kind: 'done',
      accelerator: 'Ctrl+F12',
    });
    expect(recordAccelerator(key('PrintScreen', { shiftKey: true }))).toEqual({
      kind: 'done',
      accelerator: 'Shift+PrintScreen',
    });
  });

  it('waits while only modifiers are held', () => {
    expect(recordAccelerator(key('AltLeft', { altKey: true }))).toEqual({ kind: 'pending' });
    expect(recordAccelerator(key('ShiftRight', { shiftKey: true }))).toEqual({ kind: 'pending' });
  });

  it('cancels on a bare Escape', () => {
    expect(recordAccelerator(key('Escape'))).toEqual({ kind: 'cancel' });
  });

  it('passes a bare key through for Rust to reject', () => {
    expect(recordAccelerator(key('KeyA'))).toEqual({ kind: 'done', accelerator: 'A' });
  });
});
