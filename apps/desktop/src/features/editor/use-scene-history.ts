import type { Scene } from '@cropa/core';
import { useCallback, useMemo, useReducer } from 'react';

import { canRedo, canUndo, historyReducer, initHistory } from './history.ts';
import { tryAccept } from './scene-edits.ts';

export type SceneEdit = (scene: Scene) => Scene;

const applied = (change: SceneEdit) => (scene: Scene) => tryAccept(scene, change(scene));

/** The scene being edited, with undo and redo. Every edit goes through `accept`. */
export function useSceneHistory(initial: Scene) {
  const [history, dispatch] = useReducer(historyReducer, initial, initHistory);

  const load = useCallback((scene: Scene) => { dispatch({ type: 'load', scene }); }, []);
  /** One undo step. Also ends a drag in progress, so a final value needs no extra `commit`. */
  const edit = useCallback((change: SceneEdit) => {
    dispatch({ type: 'edit', scene: applied(change) });
  }, []);
  /** A live change during a drag; no undo step until `commit` or the next `edit`. */
  const preview = useCallback((change: SceneEdit) => {
    dispatch({ type: 'preview', scene: applied(change) });
  }, []);
  const commit = useCallback(() => { dispatch({ type: 'commit' }); }, []);
  const undo = useCallback(() => { dispatch({ type: 'undo' }); }, []);
  const redo = useCallback(() => { dispatch({ type: 'redo' }); }, []);

  return useMemo(
    () => ({
      scene: history.present,
      blocked: history.blocked,
      canUndo: canUndo(history),
      canRedo: canRedo(history),
      load,
      edit,
      preview,
      commit,
      undo,
      redo,
    }),
    [history, load, edit, preview, commit, undo, redo],
  );
}

export type SceneHistory = ReturnType<typeof useSceneHistory>;
