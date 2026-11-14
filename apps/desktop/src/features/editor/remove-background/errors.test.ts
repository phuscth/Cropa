import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import type { CutoutError } from '../../../lib/bindings.ts';
import en from '../../../lib/i18n/en.json';
import vi from '../../../lib/i18n/vi.json';
import { describeCutoutError } from './errors.ts';

type Kind = CutoutError['kind'];
const KINDS: Record<Kind, true> = {
  ImageChanged: true,
  Unreadable: true,
  TooLarge: true,
  NoSubject: true,
  NoBackground: true,
  Misaligned: true,
  WeakAlignment: true,
  Save: true,
};
const SHOWN = (Object.keys(KINDS) as Kind[]).filter((kind) => kind !== 'ImageChanged');

describe('background removal errors', () => {
  for (const [language, strings] of [['en', en], ['vi', vi]] as const) {
    it.each([...SHOWN, 'ImageTooLarge'])(`${language} says what, why and what next for %s`, (kind) => {
      const message = (strings.removeBackground.errors as Record<string, Record<string, unknown>>)[kind];
      for (const part of ['what', 'why', 'next']) {
        expect(typeof message?.[part]).toBe('string');
        expect(message?.[part]).not.toBe('');
      }
    });
  }

  it('says nothing when the image changed under the run', () => {
    const t = ((key: string) => key) as TFunction;
    expect(describeCutoutError(t, { kind: 'ImageChanged' })).toBeNull();
    expect(describeCutoutError(t, { kind: 'Misaligned', detail: { dx: 3, dy: 0 } })?.what).toBe(
      'removeBackground.errors.Misaligned.what',
    );
  });
});
