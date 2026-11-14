import { describe, expect, it } from 'vitest';

import { migratePanelState } from './panel-state.ts';

describe('migratePanelState', () => {
  it('reads version 1 and falls back to closed for anything else', () => {
    expect(migratePanelState({ version: 1, open: true })).toEqual({ version: 1, open: true });
    expect(migratePanelState({ version: 1, open: false }).open).toBe(false);
    expect(migratePanelState({ version: 2, open: true }).open).toBe(false);
    expect(migratePanelState({ open: true }).open).toBe(false);
    expect(migratePanelState({ version: 1, open: 'yes' }).open).toBe(false);
    expect(migratePanelState(null).open).toBe(false);
    expect(migratePanelState('open').open).toBe(false);
  });
});
