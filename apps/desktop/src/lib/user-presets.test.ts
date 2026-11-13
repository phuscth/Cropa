import { builtinPresets, type BackgroundSpec } from '@cropa/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserPreset } from './bindings.ts';
import { deleteUserPreset, listUserPresets, onUserPresetsChanged, saveUserPreset } from './user-presets.ts';

const store = vi.hoisted(() => ({ entries: [] as UserPreset[] }));

vi.mock('./bindings.ts', () => ({
  commands: {
    listUserPresets: () => Promise.resolve({ status: 'ok', data: [...store.entries] }),
    saveUserPreset: (id: string | null, name: string, background: unknown) => {
      const entry = { id: id ?? `user-${String(store.entries.length)}`, name, background };
      store.entries.push(entry);
      return Promise.resolve({ status: 'ok', data: entry });
    },
    deleteUserPreset: (id: string) => {
      store.entries = store.entries.filter((entry) => entry.id !== id);
      return Promise.resolve({ status: 'ok', data: null });
    },
  },
}));

const base = builtinPresets[0]?.background;
if (!base) throw new Error('no built-in preset');
const aiBackground: BackgroundSpec = {
  ...base,
  layers: [
    ...base.layers,
    { type: 'code', source: 'const meta = { durationMs: 4000 };\nfunction back() {}', durationMs: 4000, threeD: false },
  ],
};

beforeEach(() => { store.entries = []; });

describe('saving a background with a code layer', () => {
  it('reaches Rust with the code layer intact and comes back from the list with it', async () => {
    const saved = await saveUserPreset({ name: 'Fireflies', background: aiBackground });
    expect(saved.status).toBe('ok');
    expect(store.entries[0]?.background).toEqual(aiBackground);

    const listed = await listUserPresets();
    if (listed.status !== 'ok') throw new Error('list failed');
    expect(listed.data.unreadable).toEqual([]);
    expect(listed.data.presets).toHaveLength(1);
    expect(listed.data.presets[0]?.background.layers.at(-1)).toMatchObject({ type: 'code', durationMs: 4000 });
  });

  it('tells listeners after a save and a delete, and not after a refused save', async () => {
    const listener = vi.fn();
    const stop = onUserPresetsChanged(listener);
    const saved = await saveUserPreset({ name: 'One', background: aiBackground });
    expect(listener).toHaveBeenCalledTimes(1);
    expect((await saveUserPreset({ name: '   ', background: aiBackground })).status).toBe('error');
    expect(listener).toHaveBeenCalledTimes(1);
    if (saved.status !== 'ok') throw new Error('save failed');
    await deleteUserPreset(saved.data.id);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    await deleteUserPreset('user-gone');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
