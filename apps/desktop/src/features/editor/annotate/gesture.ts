import { hitTest, type Annotation, type Scene } from '@cropa/core';

import {
  addAnnotation,
  createAnnotation,
  handlesFor,
  moveAnnotation,
  replaceAnnotation,
  resizeAnnotation,
  type Handle,
  type ToolStyle,
} from './annotation-edits.ts';
import type { Point } from './geometry.ts';
import type { Tool } from './tools.ts';

/** On-screen distances already converted to image pixels. */
export interface Tolerances {
  /** How far from a handle's centre still grabs it. */
  handle: number;
  /** How far outside a mark still hits it. */
  hit: number;
  /** How far the pointer must travel before a drag starts drawing or moving. */
  threshold: number;
}

/**
 * What one pointer drag is doing. Every scene it produces is computed from
 * `startScene`, so the drag never drifts, and the whole drag is one undo step.
 */
export type Gesture =
  | { kind: 'resize'; startScene: Scene; index: number; handle: Handle; original: Annotation }
  | { kind: 'move'; startScene: Scene; start: Point; index: number; original: Annotation; passed: boolean }
  | { kind: 'create'; startScene: Scene; start: Point; tool: Exclude<Tool, 'select' | 'step' | 'text'>; style: ToolStyle; passed: boolean }
  | { kind: 'place'; startScene: Scene; style: ToolStyle }
  | { kind: 'text'; startScene: Scene; at: Point };

export interface Start {
  /** The drag, or null when the press only changes the selection. */
  gesture: Gesture | null;
  /** The new selection; undefined leaves it as it was. */
  select?: number | null;
}

export interface StartInput {
  scene: Scene;
  tool: Tool;
  selected: number | null;
  point: Point;
  tolerances: Tolerances;
  style: ToolStyle;
  measure?: (text: string, font: string) => number;
}

/** Decides what a pointer press does. */
export function startGesture(input: StartInput): Start {
  const { scene, tool, selected, point, tolerances, style, measure } = input;
  const chosen = selected === null ? undefined : scene.annotations[selected];

  // A handle of the selected mark wins over any tool.
  if (selected !== null && chosen) {
    const grabbed = handlesFor(chosen).find(
      (h) =>
        Math.abs(h.x - point.x) <= tolerances.handle && Math.abs(h.y - point.y) <= tolerances.handle,
    );
    if (grabbed) {
      return {
        gesture: { kind: 'resize', startScene: scene, index: selected, handle: grabbed.handle, original: chosen },
      };
    }
  }

  const hit = () =>
    hitTest(scene, point, measure ? { tolerance: tolerances.hit, measure } : { tolerance: tolerances.hit });

  if (tool === 'select') {
    const index = hit();
    const a = index === null ? undefined : scene.annotations[index];
    if (index === null || !a) return { gesture: null, select: null };
    return {
      gesture: { kind: 'move', startScene: scene, start: point, index, original: a, passed: false },
      select: index,
    };
  }
  if (tool === 'step') {
    return {
      gesture: { kind: 'place', startScene: scene, style },
      select: scene.annotations.length,
    };
  }
  if (tool === 'text') {
    const index = hit();
    if (index !== null && scene.annotations[index]?.type === 'text') return { gesture: null, select: index };
    return { gesture: { kind: 'text', startScene: scene, at: point }, select: null };
  }
  return {
    gesture: { kind: 'create', startScene: scene, start: point, tool, style, passed: false },
  };
}

/** The scene to show the moment the press lands, for a gesture that already changes it. */
export function initialScene(gesture: Gesture, point: Point): Scene | null {
  return gesture.kind === 'place' ? placed(gesture, point) : null;
}

function placed(gesture: Extract<Gesture, { kind: 'place' }>, point: Point): Scene {
  return addAnnotation(gesture.startScene, createAnnotation('step', point, point, gesture.style));
}

/**
 * The scene for the pointer at `point`, and the gesture to keep. The scene is null
 * while a drag has not travelled past the threshold, so a plain click changes nothing.
 */
export function moveGesture(
  gesture: Gesture,
  point: Point,
  threshold: number,
): { gesture: Gesture; scene: Scene | null } {
  switch (gesture.kind) {
    case 'resize':
      return {
        gesture,
        scene: replaceAnnotation(
          gesture.startScene,
          gesture.index,
          resizeAnnotation(gesture.original, gesture.handle, point),
        ),
      };
    case 'place':
      return { gesture, scene: placed(gesture, point) };
    case 'text':
      return { gesture, scene: null };
    case 'move': {
      const passed = gesture.passed || Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= threshold;
      if (!passed) return { gesture, scene: null };
      const moved = moveAnnotation(gesture.original, point.x - gesture.start.x, point.y - gesture.start.y);
      return {
        gesture: { ...gesture, passed },
        scene: replaceAnnotation(gesture.startScene, gesture.index, moved),
      };
    }
    case 'create': {
      const passed = gesture.passed || Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= threshold;
      if (!passed) return { gesture, scene: null };
      const a = createAnnotation(gesture.tool, gesture.start, point, gesture.style);
      return { gesture: { ...gesture, passed }, scene: addAnnotation(gesture.startScene, a) };
    }
  }
}

export interface Finish {
  /** Whether the drag changed the scene and its undo step should be closed. */
  commit: boolean;
  /** The new selection; undefined leaves it as it was. */
  select?: number;
  /** Where to open the text editor for a new text. */
  openText?: Point;
}

/** What releasing the pointer does. */
export function finishGesture(gesture: Gesture): Finish {
  switch (gesture.kind) {
    case 'create':
      return gesture.passed
        ? { commit: true, select: gesture.startScene.annotations.length }
        : { commit: false };
    case 'text':
      return { commit: false, openText: gesture.at };
    case 'move':
    case 'resize':
    case 'place':
      return { commit: true };
  }
}

/** The scene Escape restores: the one before the drag. */
export function cancelGesture(gesture: Gesture): Scene {
  return gesture.startScene;
}
