import type { Annotation } from '../schema/annotation.ts';
import type { Scene } from '../schema/scene.ts';
import {
  ANNOTATION_DEFAULTS,
  arrowGeometry,
  normalizeBox,
  stepDiameter,
  textLayout,
} from './annotations.ts';
import type { TextMeasure } from './annotations.ts';
import type { Box } from './layout.ts';
import { isRedaction } from './redact.ts';

type Point = { x: number; y: number };

export interface HitOptions {
  /** Widens every target by this many image pixels. Default 0. */
  tolerance?: number;
  /** Real text widths; see `annotationBounds`. */
  measure?: TextMeasure;
}

/**
 * The area an annotation covers, in image pixels. A rect includes half its stroke,
 * an arrow its stroke and head, a step its circle (the 32 px default circle when
 * its box has no area), a text its drawn block (the box, grown to fit the text);
 * blur and pixelate are their normalised box.
 *
 * The size of a text block depends on text widths. With `measure` (the editor passes
 * the canvas's `measureText`) they are exact; without it the widest line is
 * estimated at 0.6 * fontSize per character, which is only approximately right.
 */
export function annotationBounds(a: Annotation, measure?: TextMeasure): Box {
  const b = normalizeBox(a.box);
  if (a.type === 'rect') {
    const half = (a.style?.strokeWidth ?? ANNOTATION_DEFAULTS.strokeWidth) / 2;
    return grow(b, half);
  }
  if (a.type === 'arrow') {
    const g = arrowGeometry(a.box, a.style?.strokeWidth ?? ANNOTATION_DEFAULTS.strokeWidth);
    return grow(b, g.halfWidth);
  }
  if (a.type === 'step') {
    const d = stepDiameter(a.box);
    return { x: b.x + b.w / 2 - d / 2, y: b.y + b.h / 2 - d / 2, w: d, h: d };
  }
  if (a.type === 'text') return textLayout(a, measure).block;
  return b;
}

/**
 * The index in `scene.annotations` of the topmost annotation under `point` (image
 * pixels), or null. Draw order decides: the vector annotations from last to first,
 * then blur and pixelate from last to first, because redactions are drawn first.
 * An unfilled rect is hit only on its outline, so what lies inside it can be
 * selected; a filled rect is hit over its interior.
 */
export function hitTest(scene: Scene, point: Point, options: HitOptions = {}): number | null {
  const all = scene.annotations;
  for (const wantRedaction of [false, true]) {
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const a = all[i];
      if (a && isRedaction(a) === wantRedaction && hits(a, point, options)) return i;
    }
  }
  return null;
}

function hits(a: Annotation, p: Point, options: HitOptions): boolean {
  const tolerance = options.tolerance ?? 0;
  if (a.type === 'arrow') return hitsArrow(a, p, tolerance);
  if (a.type === 'step') {
    const b = normalizeBox(a.box);
    const d = Math.hypot(p.x - (b.x + b.w / 2), p.y - (b.y + b.h / 2));
    return d <= stepDiameter(a.box) / 2 + tolerance;
  }
  const bounds = grow(annotationBounds(a, options.measure), tolerance);
  if (a.type === 'rect' && !a.style?.fill) {
    // Only the outline: outside the inner edge of the stroke.
    const reach = (a.style?.strokeWidth ?? ANNOTATION_DEFAULTS.strokeWidth) + 2 * tolerance;
    const inner = grow(bounds, -reach);
    return inside(bounds, p) && !(inner.w > 0 && inner.h > 0 && inside(inner, p));
  }
  return inside(bounds, p);
}

function hitsArrow(a: Annotation, p: Point, tolerance: number): boolean {
  const width = a.style?.strokeWidth ?? ANNOTATION_DEFAULTS.strokeWidth;
  const g = arrowGeometry(a.box, width);
  if (g.length === 0) return Math.hypot(p.x - g.tail.x, p.y - g.tail.y) <= width / 2 + tolerance;
  if (distanceToSegment(p, g.tail, g.base) <= width / 2 + tolerance) return true;

  // The head is a triangle: its axis runs from the base to the tip.
  const ux = (g.tip.x - g.base.x) / g.headLength;
  const uy = (g.tip.y - g.base.y) / g.headLength;
  const along = (p.x - g.base.x) * ux + (p.y - g.base.y) * uy;
  const across = Math.abs(-(p.x - g.base.x) * uy + (p.y - g.base.y) * ux);
  const allowed = g.halfWidth * (1 - along / g.headLength);
  return (
    along >= -tolerance &&
    along <= g.headLength + tolerance &&
    across <= Math.max(allowed, 0) + tolerance
  );
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function grow(b: Box, by: number): Box {
  return { x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by };
}

function inside(b: Box, p: Point): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}
