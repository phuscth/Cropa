import { describe, expect, it } from 'vitest';

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
