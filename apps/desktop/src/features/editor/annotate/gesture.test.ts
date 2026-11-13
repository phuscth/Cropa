import { defaultScene, type Annotation, type Scene } from '@cropa/core';
import { describe, expect, it } from 'vitest';

import { canUndo, historyReducer, initHistory, type History } from '../history.ts';
import { addAnnotation, defaultToolStyle } from './annotation-edits.ts';
import {
  cancelGesture,
  finishGesture,
  initialScene,
  moveGesture,
  startGesture,
  type Gesture,
  type Tolerances,
} from './gesture.ts';
import type { Point } from './geometry.ts';
import type { Tool } from './tools.ts';

const base = defaultScene({ width: 800, height: 600 });
const style = defaultToolStyle(base.screenshot);
const tolerances: Tolerances = { handle: 6, hit: 4, threshold: 3 };
const rect: Annotation = { version: 1, type: 'rect', box: [100, 100, 200, 100] };

/**
 * Plays one pointer drag the way the editor does: a press, moves, a release, each
 * fed to the history as the hook feeds it. Returns the history afterwards.
 */
function drag(
  scene: Scene,
  tool: Tool,
  points: Point[],
  options: { selected?: number | null; escape?: boolean } = {},
): { history: History; gesture: Gesture | null } {
  let history = initHistory(scene);
  const press = points[0] ?? { x: 0, y: 0 };
  const { gesture } = startGesture({
    scene,
    tool,
    selected: options.selected ?? null,
    point: press,
    tolerances,
    style,
  });
  if (!gesture) return { history, gesture };

  let current = gesture;
  const first = initialScene(current, press);
  if (first) history = historyReducer(history, { type: 'preview', scene: () => first });
  for (const point of points.slice(1)) {
    const moved = moveGesture(current, point, tolerances.threshold);
    current = moved.gesture;
    const next = moved.scene;
    if (next) history = historyReducer(history, { type: 'preview', scene: () => next });
  }
  if (options.escape) {
    const before = cancelGesture(current);
    history = historyReducer(history, { type: 'preview', scene: () => before });
    history = historyReducer(history, { type: 'commit' });
  } else if (finishGesture(current).commit) {
    history = historyReducer(history, { type: 'commit' });
  }
  return { history, gesture: current };
}

const undo = (h: History) => historyReducer(h, { type: 'undo' });

describe('gestures as undo steps', () => {
  it('draws a rect with one undo step back to no annotation', () => {
    const { history } = drag(base, 'rect', [
      { x: 10, y: 10 },
      { x: 40, y: 30 },
      { x: 90, y: 70 },
      { x: 120, y: 80 },
    ]);
    expect(history.present.annotations).toHaveLength(1);
    expect(history.present.annotations[0]?.box).toEqual([10, 10, 110, 70]);
    expect(history.past).toHaveLength(1);
    const back = undo(history);
    expect(back.present.annotations).toHaveLength(0);
    expect(canUndo(back)).toBe(false);
  });

  it('places a step and drags it as one undo step', () => {
    const { history } = drag(base, 'step', [
      { x: 50, y: 50 },
      { x: 60, y: 55 },
      { x: 200, y: 150 },
    ]);
    expect(history.present.annotations).toHaveLength(1);
    const [x, y, w, h] = history.present.annotations[0]?.box ?? [0, 0, 0, 0];
    expect([x + w / 2, y + h / 2]).toEqual([200, 150]);
    const back = undo(history);
    expect(back.present.annotations).toHaveLength(0);
    expect(canUndo(back)).toBe(false);
  });

  it('adds a step on a plain click, as one undo step', () => {
    const { history } = drag(base, 'step', [{ x: 50, y: 50 }]);
    expect(history.present.annotations).toHaveLength(1);
    expect(canUndo(undo(history))).toBe(false);
  });

  it('moves an existing rect with one undo step', () => {
    const scene = addAnnotation(base, rect);
    const { history } = drag(scene, 'select', [
      { x: 100, y: 150 },
      { x: 110, y: 150 },
      { x: 140, y: 170 },
    ]);
    expect(history.present.annotations[0]?.box).toEqual([140, 120, 200, 100]);
    const back = undo(history);
    expect(back.present).toBe(scene);
    expect(canUndo(back)).toBe(false);
  });

  it('adds nothing for a click with the rect tool', () => {
    const { history } = drag(base, 'rect', [{ x: 30, y: 30 }, { x: 31, y: 30 }]);
    expect(history.present).toBe(base);
    expect(canUndo(history)).toBe(false);
  });

  it('adds no step when Escape restores the scene before the drag', () => {
    const { history } = drag(base, 'rect', [{ x: 10, y: 10 }, { x: 90, y: 70 }], { escape: true });
    expect(history.present).toBe(base);
    expect(canUndo(history)).toBe(false);
    const step = drag(base, 'step', [{ x: 10, y: 10 }, { x: 30, y: 30 }], { escape: true });
    expect(canUndo(step.history)).toBe(false);
  });

  it('resizes the selected mark from its handle', () => {
    const scene = addAnnotation(base, rect);
    const { history } = drag(scene, 'select', [{ x: 300, y: 200 }, { x: 360, y: 260 }], { selected: 0 });
    expect(history.present.annotations[0]?.box).toEqual([100, 100, 260, 160]);
    expect(canUndo(undo(history))).toBe(false);
  });
});

describe('startGesture', () => {
  it('selects the mark under the pointer and nothing on empty space', () => {
    const scene = addAnnotation(base, rect);
    const on = startGesture({ scene, tool: 'select', selected: null, point: { x: 100, y: 150 }, tolerances, style });
    expect(on.select).toBe(0);
    expect(on.gesture?.kind).toBe('move');
    const off = startGesture({ scene, tool: 'select', selected: 0, point: { x: 600, y: 500 }, tolerances, style });
    expect(off).toEqual({ gesture: null, select: null });
  });

  it('opens the text editor on release only for an empty spot', () => {
    const { gesture } = startGesture({ scene: base, tool: 'text', selected: null, point: { x: 5, y: 6 }, tolerances, style });
    if (!gesture) throw new Error('expected a gesture');
    expect(finishGesture(gesture)).toEqual({ commit: false, openText: { x: 5, y: 6 } });
  });
});
