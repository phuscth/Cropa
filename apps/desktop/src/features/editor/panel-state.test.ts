import { describe, expect, it } from 'vitest';

import { migrateSidebarState } from './panel-state.ts';

describe('migrateSidebarState', () => {
  it('reads version 1 and falls back to open for anything else', () => {
    expect(migrateSidebarState({ version: 1, open: true })).toEqual({ version: 1, open: true });
    expect(migrateSidebarState({ version: 1, open: false }).open).toBe(false);
    expect(migrateSidebarState({ version: 2, open: false }).open).toBe(true);
    expect(migrateSidebarState({ open: false }).open).toBe(true);
    expect(migrateSidebarState({ version: 1, open: 'no' }).open).toBe(true);
    expect(migrateSidebarState(null).open).toBe(true);
    expect(migrateSidebarState('closed').open).toBe(true);
  });
});
