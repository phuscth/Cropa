import { describe, expect, it } from 'vitest';

import type { HistoryItem } from '../../lib/bindings.ts';
import { describeDay, groupByDay } from './history-days.ts';
import { selectRange, toggleId } from './history-selection.ts';

const ids = ['a', 'b', 'c', 'd', 'e'];

describe('history selection', () => {
  it('toggles an id in and out', () => {
    const once = toggleId(new Set(['a']), 'b');
    expect([...once]).toEqual(['a', 'b']);
    expect([...toggleId(once, 'a')]).toEqual(['b']);
  });

  it('selects the range between the anchor and the clicked id, in either direction', () => {
    expect([...selectRange(new Set(['e']), ids, 'b', 'd')].sort()).toEqual(['b', 'c', 'd', 'e']);
    expect([...selectRange(new Set(), ids, 'd', 'b')].sort()).toEqual(['b', 'c', 'd']);
  });

  it('toggles when there is no anchor in the list', () => {
    expect([...selectRange(new Set(), ids, undefined, 'c')]).toEqual(['c']);
    expect([...selectRange(new Set(['c']), ids, 'gone', 'c')]).toEqual([]);
  });
});

function item(id: string, at: Date | null): HistoryItem {
  return { id, capturedAt: at === null ? null : at.getTime(), width: 100, height: 100 };
}

describe('history day grouping', () => {
  it('keeps first-appearance order and puts captures without a time last', () => {
    const groups = groupByDay([
      item('a', new Date(2026, 4, 10, 9, 0)),
      item('n', null),
      item('b', new Date(2026, 4, 9, 9, 0)),
      item('c', new Date(2026, 4, 10, 8, 0)),
      item('m', null),
    ]);
    expect(groups.map((group) => group.key)).toEqual(['2026-05-10', '2026-05-09', 'unknown']);
    expect(groups.map((group) => group.items.map((entry) => entry.id))).toEqual([['a', 'c'], ['b'], ['n', 'm']]);
    expect(groups[0]?.day).toEqual(new Date(2026, 4, 10));
    expect(groups[2]?.day).toBeUndefined();
  });

  it('splits at local midnight', () => {
    const groups = groupByDay([
      item('late', new Date(2026, 4, 10, 23, 59)),
      item('early', new Date(2026, 4, 10, 0, 1)),
      item('before', new Date(2026, 4, 9, 23, 59)),
    ]);
    expect(groups.map((group) => group.items.map((entry) => entry.id))).toEqual([['late', 'early'], ['before']]);
  });

  it('describes how far a day is from now', () => {
    const now = new Date(2026, 4, 20, 15, 30);
    const back = (days: number) => new Date(2026, 4, 20 - days);
    expect(describeDay(back(0), now)).toBe('today');
    expect(describeDay(back(1), now)).toBe('yesterday');
    expect(describeDay(back(2), now)).toBe('thisWeek');
    expect(describeDay(back(6), now)).toBe('thisWeek');
    expect(describeDay(back(7), now)).toBe('thisYear');
    expect(describeDay(new Date(2026, 0, 2), now)).toBe('thisYear');
    expect(describeDay(new Date(2025, 11, 31), now)).toBe('older');
    expect(describeDay(new Date(2026, 4, 21), now)).toBe('today');
  });
});
