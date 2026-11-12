import type { Scene } from '@cropa/core';

/** The most undo steps kept; the oldest is dropped first. */
export const MAX_UNDO_STEPS = 100;

export interface History {
  past: Scene[];
  present: Scene;
  future: Scene[];
  /** The scene before an open drag, or null when no drag is open. */
  base: Scene | null;
  /** The last change was rejected (it would make the scene invalid), so the scene did not move. */
  blocked: boolean;
}

/**
 * A new scene, or a function that makes it from the scene at the time the action
 * runs. A function returns null to reject the change.
 */
export type SceneUpdate = Scene | ((present: Scene) => Scene | null);

export type HistoryAction =
  /** A new image: fresh history. */
  | { type: 'load'; scene: Scene }
  /** One undo step. */
  | { type: 'edit'; scene: SceneUpdate }
  /** A live change during a drag: no undo step yet. */
  | { type: 'preview'; scene: SceneUpdate }
  /** The end of a drag: one undo step back to where it began. */
  | { type: 'commit' }
  | { type: 'undo' }
  | { type: 'redo' };

export function initHistory(scene: Scene): History {
  return { past: [], present: scene, future: [], base: null, blocked: false };
}

export const canUndo = (h: History): boolean => h.past.length > 0 || h.base !== null;
export const canRedo = (h: History): boolean => h.future.length > 0;

const resolve = (update: SceneUpdate, present: Scene): Scene | null =>
  typeof update === 'function' ? update(present) : update;

/** Edits often return a new object with the same content, so scenes compare by value. */
function sameScene(a: Scene, b: Scene): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function push(past: Scene[], scene: Scene): Scene[] {
  const next = [...past, scene];
  return next.length > MAX_UNDO_STEPS ? next.slice(next.length - MAX_UNDO_STEPS) : next;
}

/** Ends an open drag: its start becomes one undo step when anything changed. */
function closeDrag(h: History): History {
  if (h.base === null) return h;
  if (sameScene(h.base, h.present)) return { ...h, present: h.base, base: null };
  return { ...h, past: push(h.past, h.base), future: [], base: null };
}

export function historyReducer(h: History, action: HistoryAction): History {
  switch (action.type) {
    case 'load':
      return initHistory(action.scene);
    case 'preview': {
      const scene = resolve(action.scene, h.present);
      if (scene === null) return { ...h, blocked: true };
      if (sameScene(scene, h.present)) return h;
      return { ...h, present: scene, base: h.base ?? h.present, blocked: false };
    }
    case 'commit':
      return closeDrag(h);
    case 'edit': {
      const closed = closeDrag(h);
      const scene = resolve(action.scene, closed.present);
      if (scene === null) return { ...closed, blocked: true };
      if (sameScene(scene, closed.present)) return closed;
      return {
        past: push(closed.past, closed.present),
        present: scene,
        future: [],
        base: null,
        blocked: false,
      };
    }
    case 'undo': {
      const closed = closeDrag(h);
      const previous = closed.past.at(-1);
      if (previous === undefined) return closed;
      return {
        past: closed.past.slice(0, -1),
        present: previous,
        future: [closed.present, ...closed.future],
        base: null,
        blocked: false,
      };
    }
    case 'redo': {
      const closed = closeDrag(h);
      const [next, ...rest] = closed.future;
      if (next === undefined) return closed;
      return {
        past: push(closed.past, closed.present),
        present: next,
        future: rest,
        base: null,
        blocked: false,
      };
    }
  }
}
