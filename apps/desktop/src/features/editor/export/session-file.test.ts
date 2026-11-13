import { describe, expect, it } from 'vitest';

import type { SaveOutcome } from '../../../lib/bindings.ts';
import { afterQuickSave, initialSessionFile, sessionFileFor } from './session-file.ts';

const saved = (id: number): SaveOutcome => ({
  kind: 'saved',
  file: { id, path: `C:/shots/${String(id)}.png`, fileName: `${String(id)}.png` },
});
const cancelled: SaveOutcome = { kind: 'cancelled' };

describe('session file', () => {
  it('sends no file for the first save of an image', () => {
    expect(sessionFileFor(initialSessionFile(1), 1)).toBeNull();
  });

  it('sends the saved file for the next save of the same image', () => {
    const state = afterQuickSave(initialSessionFile(1), 1, saved(7));
    expect(sessionFileFor(state, 1)).toBe(7);
  });

  it('keeps the previous file when a save is cancelled', () => {
    const state = afterQuickSave(afterQuickSave(initialSessionFile(1), 1, saved(7)), 1, cancelled);
    expect(sessionFileFor(state, 1)).toBe(7);
  });

  it('sends no file once a new image is loaded', () => {
    const state = afterQuickSave(initialSessionFile(1), 1, saved(7));
    expect(sessionFileFor(state, 2)).toBeNull();
    expect(sessionFileFor(afterQuickSave(state, 2, cancelled), 2)).toBeNull();
  });
});
