import { useSyncExternalStore, type ComponentProps } from 'react';

import type { ExportFormat } from '../../lib/bindings.ts';
import type { ExportSize } from '../editor/export/plan.ts';

/** Pointer handlers of the drag-out handle. */
export type DragHandlers = Pick<
  ComponentProps<'button'>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture'
>;

/** The export choices shown in the Save popover and the sizes they give. */
export interface ExportOptions {
  format: ExportFormat;
  size: ExportSize;
  setFormat: (format: ExportFormat) => void;
  setSize: (size: ExportSize) => void;
  /** The screenshot's size in pixels. */
  imageSize: { width: number; height: number };
  /** The output size for the chosen format and size. */
  output: { width: number; height: number };
  /** The output size of each size choice for the scene. */
  sizes: Record<ExportSize, { width: number; height: number }>;
  /** Platform sizes always export at their own size, so the size choice is off. */
  sizeFixed: boolean;
}

/**
 * What the editor can do right now, published for the title bar's buttons. The
 * editor owns the actions; the title bar only calls them.
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
  /** Saves right away with the format and size chosen in the Save popover. */
  quickSave: () => void;
  /** Opens the native save dialog with the format and size chosen in the Save popover. */
  saveAs: () => void;
  exportOptions: ExportOptions;
  dragHandlers: DragHandlers;
}

type Listener = () => void;

let actions: EditorActions | null = null;
let snapshot: EditorSnapshot = { actions };
const listeners = new Set<Listener>();

interface EditorSnapshot {
  actions: EditorActions | null;
}

function emit() {
  snapshot = { actions };
  for (const listener of listeners) listener();
}

/** Called by the editor view; `null` when it is gone. */
export function publishEditorActions(next: EditorActions | null): void {
  actions = next;
  emit();
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
