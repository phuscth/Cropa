import { ANNOTATION_DEFAULTS, clamp, type Annotation, type Scene } from '@cropa/core';

import type { Point, Size } from './geometry.ts';
import type { Tool } from './tools.ts';

type Style = NonNullable<Annotation['style']>;

export interface ToolStyle {
  color: string;
  strokeWidth: number;
  fontSize: number;
  stepSize: number;
  strength: number;
}

/** Defaults scaled to the screenshot, so marks look alike at any resolution. */
export function defaultToolStyle(size: Size): ToolStyle {
  const m = Math.max(size.width, size.height);
  return {
    color: ANNOTATION_DEFAULTS.color,
    strokeWidth: clamp(Math.round(m * 0.0025), 2, 64),
    fontSize: clamp(Math.round(m * 0.0125), 12, 512),
    stepSize: clamp(Math.round(m * 0.02), 24, 512),
    strength: clamp(Math.round(m * 0.006), 4, 256),
  };
}

function normalised(a: Point, b: Point): Annotation['box'] {
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)];
}

export function createAnnotation(
  tool: Exclude<Tool, 'select'>,
  start: Point,
  end: Point,
  style: ToolStyle,
): Annotation {
  const base = { version: 1 } as const;
  switch (tool) {
    case 'arrow':
      return {
        ...base,
        type: 'arrow',
        box: [start.x, start.y, end.x - start.x, end.y - start.y],
        style: { color: style.color, strokeWidth: style.strokeWidth },
      };
    case 'rect':
      return {
        ...base,
        type: 'rect',
        box: normalised(start, end),
        style: { color: style.color, strokeWidth: style.strokeWidth },
      };
    case 'blur':
    case 'pixelate':
      return { ...base, type: tool, box: normalised(start, end), style: { strength: style.strength } };
    case 'step':
      return {
        ...base,
        type: 'step',
        box: [
          start.x - style.stepSize / 2,
          start.y - style.stepSize / 2,
          style.stepSize,
          style.stepSize,
        ],
        style: { color: style.color },
      };
    case 'text':
      return {
        ...base,
        type: 'text',
        box: [start.x, start.y, 0, 0],
        text: '',
        style: { color: style.color, fontSize: style.fontSize },
      };
  }
}

// ------------------------------------------------------------ scene edits

export function addAnnotation(scene: Scene, a: Annotation): Scene {
  return { ...scene, annotations: [...scene.annotations, a] };
}

export function replaceAnnotation(scene: Scene, index: number, a: Annotation): Scene {
  if (index < 0 || index >= scene.annotations.length) return scene;
  return { ...scene, annotations: scene.annotations.map((old, i) => (i === index ? a : old)) };
}

export function removeAnnotation(scene: Scene, index: number): Scene {
  if (index < 0 || index >= scene.annotations.length) return scene;
  return { ...scene, annotations: scene.annotations.filter((_, i) => i !== index) };
}

/** Appends a copy shifted by `offset` on both axes; a copied step takes the next number. */
export function duplicateAnnotation(
  scene: Scene,
  index: number,
  offset: number,
): { scene: Scene; index: number } {
  const a = scene.annotations[index];
  if (!a) return { scene, index };
  const copy = moveAnnotation(a, offset, offset);
  return { scene: addAnnotation(scene, copy), index: scene.annotations.length };
}

export function moveAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  const [x, y, w, h] = a.box;
  return { ...a, box: [x + dx, y + dy, w, h] };
}

// ---------------------------------------------------------------- handles

export type Handle = 'start' | 'end' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

function boxOf(a: Annotation): { x: number; y: number; w: number; h: number } {
  const [x, y, w, h] = a.box;
  return { x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.abs(w), h: Math.abs(h) };
}

/** The step circle's centre and the side of its bounding square. */
function stepSquare(a: Annotation): { cx: number; cy: number; side: number } {
  const b = boxOf(a);
  const side = Math.min(b.w, b.h);
  return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, side: side === 0 ? 32 : side };
}

export function handlesFor(a: Annotation): { handle: Handle; x: number; y: number }[] {
  if (a.type === 'text') return [];
  if (a.type === 'arrow') {
    const [x, y, w, h] = a.box;
    return [
      { handle: 'start', x, y },
      { handle: 'end', x: x + w, y: y + h },
    ];
  }
  if (a.type === 'step') {
    const { cx, cy, side } = stepSquare(a);
    const r = side / 2;
    return [
      { handle: 'nw', x: cx - r, y: cy - r },
      { handle: 'ne', x: cx + r, y: cy - r },
      { handle: 'se', x: cx + r, y: cy + r },
      { handle: 'sw', x: cx - r, y: cy + r },
    ];
  }
  const { x, y, w, h } = boxOf(a);
  return [
    { handle: 'nw', x, y },
    { handle: 'n', x: x + w / 2, y },
    { handle: 'ne', x: x + w, y },
    { handle: 'e', x: x + w, y: y + h / 2 },
    { handle: 'se', x: x + w, y: y + h },
    { handle: 's', x: x + w / 2, y: y + h },
    { handle: 'sw', x, y: y + h },
    { handle: 'w', x, y: y + h / 2 },
  ];
}

export function resizeAnnotation(a: Annotation, handle: Handle, p: Point): Annotation {
  if (a.type === 'arrow') {
    const [x, y, w, h] = a.box;
    if (handle === 'start') return { ...a, box: [p.x, p.y, x + w - p.x, y + h - p.y] };
    if (handle === 'end') return { ...a, box: [x, y, p.x - x, p.y - y] };
    return a;
  }
  if (a.type === 'step') {
    const { cx, cy } = stepSquare(a);
    const side = Math.max(8, 2 * Math.max(Math.abs(p.x - cx), Math.abs(p.y - cy)));
    return { ...a, box: [cx - side / 2, cy - side / 2, side, side] };
  }
  if (a.type === 'text') return a;
  const b = boxOf(a);
  let left = b.x;
  let right = b.x + b.w;
  let top = b.y;
  let bottom = b.y + b.h;
  if (handle.includes('w')) left = p.x;
  if (handle.includes('e')) right = p.x;
  if (handle.includes('n')) top = p.y;
  if (handle.includes('s')) bottom = p.y;
  return {
    ...a,
    box: [Math.min(left, right), Math.min(top, bottom), Math.abs(right - left), Math.abs(bottom - top)],
  };
}

// ------------------------------------------------------------- properties

export function setAnnotationStyle(a: Annotation, patch: Partial<Style>): Annotation {
  return { ...a, style: { ...a.style, ...patch } };
}

export function setAnnotationText(a: Annotation, text: string): Annotation {
  return { ...a, text };
}

/** A square box of `size` around the same centre. */
export function setStepSize(a: Annotation, size: number): Annotation {
  const { cx, cy } = stepSquare(a);
  return { ...a, box: [cx - size / 2, cy - size / 2, size, size] };
}

/** The size of a step's circle, which `setStepSize` sets. */
export function stepSize(a: Annotation): number {
  return stepSquare(a).side;
}

/** The number the renderer draws for the step at `index`, or null when it is not a step. */
export function stepNumber(scene: Scene, index: number): number | null {
  if (scene.annotations[index]?.type !== 'step') return null;
  return scene.annotations.slice(0, index + 1).filter((a) => a.type === 'step').length;
}
