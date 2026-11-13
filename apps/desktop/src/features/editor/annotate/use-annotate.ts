import { ANNOTATION_DEFAULTS, hitTest, type Annotation, type Scene } from '@cropa/core';
import { useCallback, useEffect, useRef, useState, type PointerEvent, type MouseEvent } from 'react';

import { isTextField, keyLetter } from '../keyboard.ts';
import type { SceneHistory } from '../use-scene-history.ts';
import {
  addAnnotation,
  createAnnotation,
  defaultToolStyle,
  duplicateAnnotation,
  handlesFor,
  removeAnnotation,
  replaceAnnotation,
  setAnnotationStyle,
  setAnnotationText,
  setStepSize,
  stepSize,
  type Handle,
  type ToolStyle,
} from './annotation-edits.ts';
import { imagePerCss, toCss, toImage, type Point, type PreviewGeometry } from './geometry.ts';
import {
  cancelGesture,
  finishGesture,
  initialScene,
  moveGesture,
  startGesture,
  type Gesture,
  type Tolerances,
} from './gesture.ts';
import { measureText } from './measure.ts';
import { toolForKey, type Tool } from './tools.ts';

/** On-screen distances, in CSS px. */
const HANDLE_REACH = 6;
const HIT_REACH = 4;
const DRAG_THRESHOLD = 3;
const DUPLICATE_OFFSET = 16;

export interface TextEditing {
  /** The annotation being edited, or null for a new one. */
  index: number | null;
  /** Where the text block's top-left is, in image px. */
  at: Point;
  text: string;
}

type Args = {
  history: Pick<SceneHistory, 'scene' | 'edit' | 'preview' | 'commit' | 'undo' | 'redo'>;
  /** Counts loaded images; a new one resets the selection and the tool style. */
  imageId: number;
  /** False until an image is loaded. */
  enabled: boolean;
};

const HANDLE_CURSORS: Record<Handle, string> = {
  start: 'move',
  end: 'move',
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

export type ValueKind = 'strokeWidth' | 'fontSize' | 'stepSize' | 'strength';

export function useAnnotate({ history, imageId, enabled }: Args) {
  const { scene, edit, preview, commit, undo, redo } = history;
  const [tool, setTool] = useState<Tool>('select');
  const [selectedRaw, setSelected] = useState<number | null>(null);
  const [style, setStyle] = useState<ToolStyle>(() => defaultToolStyle(scene.screenshot));
  const [editing, setEditing] = useState<TextEditing | null>(null);
  const [cursor, setCursor] = useState('default');
  const [seenImage, setSeenImage] = useState(imageId);

  // A new image starts clean, with marks sized for it.
  if (seenImage !== imageId) {
    setSeenImage(imageId);
    setSelected(null);
    setEditing(null);
    setStyle(defaultToolStyle(scene.screenshot));
  }
  const selected =
    selectedRaw !== null && selectedRaw < scene.annotations.length ? selectedRaw : null;
  if (selectedRaw !== null && selected === null) setSelected(null);

  const latest = useRef({ scene, style, selected, tool, editing });
  useEffect(() => { latest.current = { scene, style, selected, tool, editing }; });
  /** Set by the overlay on each render, so keyboard actions can convert units too. */
  const geometry = useRef<PreviewGeometry | undefined>(undefined);
  const setGeometry = useCallback((g: PreviewGeometry) => { geometry.current = g; }, []);
  const drag = useRef<Gesture | null>(null);
  const editingRef = useRef<TextEditing | null>(null);
  useEffect(() => { editingRef.current = editing; }, [editing]);

  const cssPoint = (event: PointerEvent | MouseEvent): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const hit = (g: PreviewGeometry, at: Point, current: Scene): number | null =>
    hitTest(current, at, { tolerance: HIT_REACH * imagePerCss(current, g), measure: measureText });

  const handleAt = (g: PreviewGeometry, css: Point, current: Scene, index: number | null): Handle | null => {
    const a = index === null ? undefined : current.annotations[index];
    if (!a) return null;
    for (const h of handlesFor(a)) {
      const c = toCss(current, g, h);
      if (Math.abs(c.x - css.x) <= HANDLE_REACH && Math.abs(c.y - css.y) <= HANDLE_REACH) return h.handle;
    }
    return null;
  };

  const select = useCallback((index: number | null) => { setSelected(index); }, []);

  const openText = useCallback((next: TextEditing) => {
    editingRef.current = next;
    setEditing(next);
  }, []);

  const cancelText = useCallback(() => {
    editingRef.current = null;
    setEditing(null);
  }, []);

  /** Applies the text editor: add, change or remove, as one undo step. */
  const commitText = useCallback(() => {
    const open = editingRef.current;
    if (!open) return;
    editingRef.current = null;
    setEditing(null);
    const { scene: current, style: toolStyle } = latest.current;
    if (open.index === null) {
      if (open.text === '') return;
      const a = { ...createAnnotation('text', open.at, open.at, toolStyle), text: open.text };
      edit((s) => addAnnotation(s, a));
      setSelected(current.annotations.length);
      return;
    }
    const old = current.annotations[open.index];
    if (!old) return;
    if (open.text === '') {
      edit((s) => removeAnnotation(s, open.index ?? -1));
      setSelected(null);
    } else if (open.text !== (old.text ?? '')) {
      edit((s) => replaceAnnotation(s, open.index ?? -1, setAnnotationText(old, open.text)));
    }
  }, [edit]);

  const setEditingText = useCallback((text: string) => {
    setEditing((open) => {
      if (!open) return open;
      const next = { ...open, text };
      editingRef.current = next;
      return next;
    });
  }, []);

  const cancelDrag = useCallback((): boolean => {
    const d = drag.current;
    if (!d) return false;
    drag.current = null;
    const before = cancelGesture(d);
    preview(() => before);
    commit();
    return true;
  }, [preview, commit]);

  // ------------------------------------------------------------- pointer

  const tolerances = (current: Scene, g: PreviewGeometry): Tolerances => {
    const perCss = imagePerCss(current, g);
    return { handle: HANDLE_REACH * perCss, hit: HIT_REACH * perCss, threshold: DRAG_THRESHOLD * perCss };
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>, g: PreviewGeometry) => {
    if (!enabled || event.button !== 0 || editingRef.current) return;
    const { scene: current, style: toolStyle, selected: chosen } = latest.current;
    const p = toImage(current, g, cssPoint(event));
    event.currentTarget.setPointerCapture(event.pointerId);

    const { gesture, select: next } = startGesture({
      scene: current,
      tool,
      selected: chosen,
      point: p,
      tolerances: tolerances(current, g),
      style: toolStyle,
      measure: measureText,
    });
    if (next !== undefined) setSelected(next);
    drag.current = gesture;
    const first = gesture ? initialScene(gesture, p) : null;
    if (first) preview(() => first);
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>, g: PreviewGeometry) => {
    const d = drag.current;
    const css = cssPoint(event);
    const { scene: current, selected: chosen } = latest.current;
    if (!d) {
      const handle = handleAt(g, css, current, chosen);
      if (handle) setCursor(HANDLE_CURSORS[handle]);
      else if (tool === 'select') setCursor(hit(g, toImage(current, g, css), current) === null ? 'default' : 'move');
      else setCursor(tool === 'text' ? 'text' : 'crosshair');
      return;
    }
    const moved = moveGesture(d, toImage(d.startScene, g, css), tolerances(d.startScene, g).threshold);
    drag.current = moved.gesture;
    const next = moved.scene;
    if (next) preview(() => next);
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!d) return;
    const done = finishGesture(d);
    if (done.commit) commit();
    if (done.select !== undefined) setSelected(done.select);
    if (done.openText) openText({ index: null, at: done.openText, text: '' });
  };

  const onDoubleClick = (event: MouseEvent<HTMLElement>, g: PreviewGeometry) => {
    // A double click inside the text editor belongs to the textarea.
    if (!enabled || editingRef.current) return;
    const { scene: current } = latest.current;
    const index = hit(g, toImage(current, g, cssPoint(event)), current);
    const a = index === null ? undefined : current.annotations[index];
    if (index === null || a?.type !== 'text') return;
    setSelected(index);
    openText({ index, at: { x: a.box[0], y: a.box[1] }, text: a.text ?? '' });
  };

  // ------------------------------------------------------------ keyboard

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextField(event.target) || editingRef.current) return;
      const { selected: chosen, scene: current } = latest.current;
      if (event.key === 'Escape') {
        if (cancelDrag()) return;
        if (chosen !== null) setSelected(null);
        else setTool('select');
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && keyLetter(event) === 'd') {
        if (chosen === null) return;
        const g = geometry.current;
        const offset = Math.round(DUPLICATE_OFFSET * (g ? imagePerCss(current, g) : 1));
        const copy = duplicateAnnotation(current, chosen, offset);
        edit(() => copy.scene);
        setSelected(copy.index);
        event.preventDefault();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (chosen === null || event.ctrlKey || event.metaKey || event.altKey) return;
        edit((s) => removeAnnotation(s, chosen));
        setSelected(null);
        event.preventDefault();
        return;
      }
      const next = toolForKey(event);
      if (next) {
        setTool(next);
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [enabled, edit, cancelDrag]);

  // ------------------------------------------------------------ properties

  const selectedAnnotation = selected === null ? undefined : scene.annotations[selected];

  /** The value the properties bar shows: the selected mark's, else the next mark's. */
  const valueOf = (kind: ValueKind): number => {
    const a = selectedAnnotation;
    if (!a) return style[kind];
    switch (kind) {
      case 'strokeWidth': return a.style?.strokeWidth ?? ANNOTATION_DEFAULTS.strokeWidth;
      case 'fontSize': return a.style?.fontSize ?? ANNOTATION_DEFAULTS.fontSize;
      case 'stepSize': return stepSize(a);
      case 'strength':
        return a.style?.strength ?? (a.type === 'blur' ? ANNOTATION_DEFAULTS.blur : ANNOTATION_DEFAULTS.pixelate);
    }
  };

  const withSelected = (change: (a: Annotation) => Annotation) => (s: Scene): Scene => {
    const index = latest.current.selected;
    const a = index === null ? undefined : s.annotations[index];
    return index === null || !a ? s : replaceAnnotation(s, index, change(a));
  };

  const setColor = (color: string) => {
    setStyle((old) => ({ ...old, color }));
    if (selected !== null) edit(withSelected((a) => setAnnotationStyle(a, { color })));
  };

  /** A live slider value; one undo step comes from `commitValue`. */
  const previewValue = (kind: ValueKind, value: number) => {
    setStyle((old) => ({ ...old, [kind]: value }));
    if (selected === null) return;
    preview(
      withSelected((a) =>
        kind === 'stepSize' ? setStepSize(a, value) : setAnnotationStyle(a, { [kind]: value }),
      ),
    );
  };

  const removeSelected = () => {
    if (selected === null) return;
    edit((s) => removeAnnotation(s, selected));
    setSelected(null);
  };

  // Undo and redo clear the selection, since the marks it points at may change.
  const undoAndDeselect = useCallback(() => {
    cancelText();
    setSelected(null);
    undo();
  }, [cancelText, undo]);
  const redoAndDeselect = useCallback(() => {
    cancelText();
    setSelected(null);
    redo();
  }, [cancelText, redo]);

  return {
    tool,
    setTool,
    selected,
    select,
    selectedAnnotation,
    style,
    editing,
    cursor,
    setGeometry,
    setEditingText,
    commitText,
    cancelText,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    valueOf,
    setColor,
    previewValue,
    commitValue: commit,
    removeSelected,
    undo: undoAndDeselect,
    redo: redoAndDeselect,
  };
}

export type Annotate = ReturnType<typeof useAnnotate>;
