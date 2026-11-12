import { defaultScene, type Scene } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import {
  canRedo,
  canUndo,
  historyReducer,
  initHistory,
  MAX_UNDO_STEPS,
  type History,
  type HistoryAction,
} from './history.ts';

const scene = (padding: number): Scene => {
  const s = defaultScene({ width: 800, height: 600 });
  return { ...s, frame: { ...s.frame, padding } };
};

const setPadding = (s: Scene, p: number): Scene => ({ ...s, frame: { ...s.frame, padding: p } });
const run = (h: History, ...actions: HistoryAction[]) => actions.reduce(historyReducer, h);
const padding = (h: History) => h.present.frame.padding;

describe('historyReducer', () => {
  it('turns a drag of many previews into one undo step back to where it began', () => {
    const start = scene(10);
    let h = initHistory(start);
    for (const p of [20, 30, 40, 50]) h = run(h, { type: 'preview', scene: scene(p) });
    expect(h.past).toHaveLength(0);
    h = run(h, { type: 'commit' });
    expect(h.past).toEqual([start]);
    expect(padding(h)).toBe(50);

    h = run(h, { type: 'undo' });
    expect(h.present).toBe(start);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(true);
  });

  it('adds no step when a drag ends where it began, or when no drag is open', () => {
    const start = scene(10);
    const idle = initHistory(start);
    expect(historyReducer(idle, { type: 'commit' })).toBe(idle);

    // The edit functions return a new object with equal content when a drag comes back.
    const there = (s: Scene) => setPadding(s, 20);
    const back = (s: Scene) => setPadding(s, 10);
    let h = run(idle, { type: 'preview', scene: there }, { type: 'preview', scene: back });
    expect(h.present).not.toBe(start);
    h = run(h, { type: 'commit' });
    expect(h.past).toHaveLength(0);
    expect(h.base).toBeNull();
    expect(canUndo(h)).toBe(false);
  });

  it('makes an edit one step and clears the redo stack', () => {
    let h = run(initHistory(scene(1)), { type: 'edit', scene: scene(2) }, { type: 'edit', scene: scene(3) });
    h = run(h, { type: 'undo' });
    expect(canRedo(h)).toBe(true);
    h = run(h, { type: 'edit', scene: scene(9) });
    expect(canRedo(h)).toBe(false);
    expect(h.past.map((s) => s.frame.padding)).toEqual([1, 2]);
  });

  it('ignores an edit that returns the same scene', () => {
    const h = initHistory(scene(1));
    expect(historyReducer(h, { type: 'edit', scene: h.present })).toBe(h);
    expect(historyReducer(h, { type: 'edit', scene: (s) => s })).toBe(h);
    expect(historyReducer(h, { type: 'edit', scene: (s) => setPadding(s, 1) })).toBe(h);
  });

  it('applies an updater to the scene at the time of the action', () => {
    const bump = (s: Scene): Scene => ({ ...s, frame: { ...s.frame, padding: s.frame.padding + 1 } });
    const h = run(
      initHistory(scene(0)),
      { type: 'preview', scene: bump },
      { type: 'preview', scene: bump },
      { type: 'commit' },
    );
    expect(padding(h)).toBe(2);
    expect(h.past).toHaveLength(1);
  });

  it('closes an open drag before undo, so the drag is undone as one step', () => {
    const start = scene(10);
    let h = run(initHistory(start), { type: 'preview', scene: scene(20) });
    expect(canUndo(h)).toBe(true);
    h = run(h, { type: 'undo' });
    expect(h.present).toBe(start);
    expect(h.base).toBeNull();
    expect(h.future.map((s) => s.frame.padding)).toEqual([20]);
  });

  it('closes an open drag before an edit', () => {
    let h = run(initHistory(scene(10)), { type: 'preview', scene: scene(20) }, { type: 'edit', scene: scene(30) });
    expect(h.past.map((s) => s.frame.padding)).toEqual([10, 20]);
    h = run(h, { type: 'undo' }, { type: 'undo' });
    expect(padding(h)).toBe(10);
  });

  it('redoes what was undone, and does nothing at either end', () => {
    const idle = initHistory(scene(1));
    expect(historyReducer(idle, { type: 'undo' })).toBe(idle);
    expect(historyReducer(idle, { type: 'redo' })).toBe(idle);

    let h = run(idle, { type: 'edit', scene: scene(2) }, { type: 'undo' }, { type: 'redo' });
    expect(padding(h)).toBe(2);
    expect(historyReducer(h, { type: 'redo' })).toBe(h);
    h = run(h, { type: 'undo' });
    expect(padding(h)).toBe(1);
  });

  it('starts fresh on load', () => {
    const h = run(initHistory(scene(1)), { type: 'edit', scene: scene(2) }, { type: 'preview', scene: scene(3) });
    const fresh = scene(7);
    expect(historyReducer(h, { type: 'load', scene: fresh })).toEqual({
      past: [],
      present: fresh,
      future: [],
      base: null,
      blocked: false,
    });
  });

  it('keeps the scene and flags a rejected change until a change applies', () => {
    const start = scene(10);
    let h = run(initHistory(start), { type: 'edit', scene: () => null });
    expect(h.present).toBe(start);
    expect(h.past).toHaveLength(0);
    expect(h.blocked).toBe(true);

    h = run(h, { type: 'preview', scene: () => null });
    expect(h.blocked).toBe(true);
    expect(h.base).toBeNull();

    h = run(h, { type: 'edit', scene: scene(20) });
    expect(h.blocked).toBe(false);
    h = run(h, { type: 'edit', scene: () => null }, { type: 'undo' });
    expect(h.blocked).toBe(false);
    h = run(h, { type: 'edit', scene: () => null }, { type: 'load', scene: scene(1) });
    expect(h.blocked).toBe(false);
  });

  it('keeps an open drag when a later preview of it is rejected', () => {
    const start = scene(10);
    let h = run(initHistory(start), { type: 'preview', scene: scene(20) }, { type: 'preview', scene: () => null });
    expect(h.present.frame.padding).toBe(20);
    h = run(h, { type: 'commit' });
    expect(h.past).toEqual([start]);
  });

  it('keeps at most 100 undo steps, dropping the oldest', () => {
    let h = initHistory(scene(0));
    for (let i = 1; i <= MAX_UNDO_STEPS + 20; i += 1) h = run(h, { type: 'edit', scene: scene(i) });
    expect(h.past).toHaveLength(MAX_UNDO_STEPS);
    expect(h.past[0]?.frame.padding).toBe(20);
  });
});
