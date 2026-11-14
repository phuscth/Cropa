import { describe, expect, it } from 'vitest';

import { filterModels, nextActive } from './model-picker.ts';

const models = [
  { provider: 'codex', name: 'GPT-5.6 Sol', favorite: true },
  { provider: 'codex', name: 'GPT-5.6 Terra', favorite: false },
  { provider: 'claude', name: 'Opus 5.5', favorite: true },
  { provider: 'claude', name: 'Sonnet', favorite: false },
];

describe('filterModels', () => {
  it('keeps one provider, in order', () => {
    expect(filterModels(models, 'claude', '').map((m) => m.name)).toEqual(['Opus 5.5', 'Sonnet']);
  });

  it('keeps the starred models of every provider in the favorites view', () => {
    expect(filterModels(models, 'favorites', '').map((m) => m.name)).toEqual(['GPT-5.6 Sol', 'Opus 5.5']);
  });

  it('matches the query inside the filter, ignoring case and outer spaces', () => {
    expect(filterModels(models, 'codex', '  terra ').map((m) => m.name)).toEqual(['GPT-5.6 Terra']);
    expect(filterModels(models, 'favorites', 'sonnet')).toEqual([]);
  });
});

describe('nextActive', () => {
  it('moves and wraps', () => {
    expect(nextActive(0, 3, 'ArrowDown')).toBe(1);
    expect(nextActive(2, 3, 'ArrowDown')).toBe(0);
    expect(nextActive(0, 3, 'ArrowUp')).toBe(2);
    expect(nextActive(2, 3, 'ArrowUp')).toBe(1);
  });

  it('starts from the ends when nothing is active', () => {
    expect(nextActive(-1, 3, 'ArrowDown')).toBe(0);
    expect(nextActive(-1, 3, 'ArrowUp')).toBe(2);
  });

  it('jumps with Home and End and returns -1 for an empty list', () => {
    expect(nextActive(1, 4, 'Home')).toBe(0);
    expect(nextActive(1, 4, 'End')).toBe(3);
    expect(nextActive(0, 0, 'ArrowDown')).toBe(-1);
  });
});
