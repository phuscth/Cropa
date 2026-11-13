import { useSyncExternalStore } from 'react';

/**
 * What the editor can do right now, published for the title bar's menus. The
 * editor owns the actions; the menus only call them.
 */
export interface EditorActions {
  /** An image is loaded, so copy, save and export apply. */
  hasImage: boolean;
  /** An export is running. */
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  copy: () => void;
  quickSave: () => void;
  /** Opens the native save dialog with the format and scale chosen in the export section. */
  saveAs: () => void;
}

type Listener = () => void;

let actions: EditorActions | null = null;
/** Saves the current background as a preset file; set while the presets section is mounted. */
let exportPreset: (() => void) | null = null;
let snapshot: EditorSnapshot = { actions, exportPreset };
const listeners = new Set<Listener>();

interface EditorSnapshot {
  actions: EditorActions | null;
  exportPreset: (() => void) | null;
}

function emit() {
  snapshot = { actions, exportPreset };
  for (const listener of listeners) listener();
}

/** Called by the editor view; `null` when it is gone. */
export function publishEditorActions(next: EditorActions | null): void {
  actions = next;
  emit();
}

/** Called by the presets section; returns the cleanup. */
export function registerPresetExport(run: () => void): () => void {
  exportPreset = run;
  emit();
  return () => {
    if (exportPreset === run) {
      exportPreset = null;
      emit();
    }
  };
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): EditorSnapshot {
  return snapshot;
}

/** The editor's published actions, or `null` while it is not mounted. */
export function useEditorActions(): EditorSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}
