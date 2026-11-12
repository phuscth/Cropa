import type { Annotation } from '../schema/annotation.ts';
import { parseHex } from '../schema/color.ts';
import type { Scene } from '../schema/scene.ts';
import type { Canvas2D } from './canvas.ts';
import type { Box } from './layout.ts';
import { roundedRect } from './shapes.ts';

/** Values used when an annotation's `style` leaves a field out. Sizes are in image pixels. */
export const ANNOTATION_DEFAULTS = {
  color: '#ef4444',
  strokeWidth: 4,
  fontSize: 24,
  /** Blur strength, see `blur` in redact.ts. */
  blur: 12,
  /** Pixelate block size. */
  pixelate: 12,
} as const;

/** Font family of text and step labels; the first installed family wins. */
export const ANNOTATION_FONT = 'Inter, "Segoe UI", system-ui, sans-serif';

/** Diameter of a step circle whose box has no area. */
const DEFAULT_STEP_DIAMETER = 32;
const DARK_LABEL = '#111827';

/** The box as a rectangle with its min corner and non-negative size. */
export function normalizeBox(box: Annotation['box']): Box {
  const [x, y, w, h] = box;
  return { x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.abs(w), h: Math.abs(h) };
}

export function stepDiameter(box: Annotation['box']): number {
  const { w, h } = normalizeBox(box);
  return Math.min(w, h) || DEFAULT_STEP_DIAMETER;
}

export interface ArrowGeometry {
  tail: { x: number; y: number };
  tip: { x: number; y: number };
  /** Distance from tail to tip. */
  length: number;
  /** The head is a filled triangle: tip, and two corners `halfWidth` either side of `base`. */
  headLength: number;
  halfWidth: number;
  /** Where the shaft ends and the head begins. */
  base: { x: number; y: number };
}

/**
 * Arrow head rule: the head is max(3 * width + 6, 10) long, never more than half
 * the arrow, and 0.6 of its length wide on each side (never narrower than the
 * stroke). The shaft stops at the head's base.
 */
export function arrowGeometry(box: Annotation['box'], width: number): ArrowGeometry {
  const [x, y, w, h] = box;
  const length = Math.hypot(w, h);
  const headLength = Math.min(0.5 * length, Math.max(3 * width + 6, 10));
  const halfWidth = Math.max(0.6 * headLength, width);
  const ux = length > 0 ? w / length : 0;
  const uy = length > 0 ? h / length : 0;
  return {
    tail: { x, y },
    tip: { x: x + w, y: y + h },
    length,
    headLength,
    halfWidth,
    base: { x: x + w - ux * headLength, y: y + h - uy * headLength },
  };
}

/**
 * Draws every annotation except blur and pixelate (see `redactScreenshot`) in array
 * order, over the whole canvas including the padding. `shot` is the screenshot's
 * rectangle on the canvas; annotations are drawn in image pixels mapped through it,
 * so stroke widths and font sizes scale with the output.
 */
export function drawAnnotations(scene: Scene, shot: Box, ctx: Canvas2D): void {
  const kx = shot.w / scene.screenshot.width;
  const ky = shot.h / scene.screenshot.height;
  ctx.save();
  try {
    ctx.setTransform(kx, 0, 0, ky, shot.x, shot.y);
    ctx.globalAlpha = 1;
    ctx.shadowColor = 'rgba(0,0,0,0)';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    let ordinal = 0;
    for (const a of scene.annotations) {
      switch (a.type) {
        case 'arrow':
          drawArrow(ctx, a);
          break;
        case 'rect':
          drawRect(ctx, a);
          break;
        case 'text':
          drawText(ctx, a);
          break;
        case 'step':
          ordinal += 1;
          drawStep(ctx, a, ordinal);
          break;
        case 'blur':
        case 'pixelate':
          break;
      }
    }
  } finally {
    ctx.restore();
  }
}

function drawArrow(ctx: Canvas2D, a: Annotation): void {
  const color = a.style?.color ?? ANNOTATION_DEFAULTS.color;
  const width = a.style?.strokeWidth ?? ANNOTATION_DEFAULTS.strokeWidth;
  const g = arrowGeometry(a.box, width);
  if (g.length === 0) return;

  const ux = (g.tip.x - g.base.x) / g.headLength;
  const uy = (g.tip.y - g.base.y) / g.headLength;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(g.tail.x, g.tail.y);
  ctx.lineTo(g.base.x, g.base.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(g.tip.x, g.tip.y);
  ctx.lineTo(g.base.x - uy * g.halfWidth, g.base.y + ux * g.halfWidth);
  ctx.lineTo(g.base.x + uy * g.halfWidth, g.base.y - ux * g.halfWidth);
  ctx.closePath();
  ctx.fill();
}

function drawRect(ctx: Canvas2D, a: Annotation): void {
  const b = normalizeBox(a.box);
  if (b.w === 0 || b.h === 0) return;
  const radius = a.style?.radius ?? 0;
  roundedRect(ctx, b.x, b.y, b.w, b.h, radius);
  if (a.style?.fill) {
    ctx.fillStyle = a.style.fill;
    ctx.fill();
  }
  ctx.strokeStyle = a.style?.color ?? ANNOTATION_DEFAULTS.color;
  ctx.lineWidth = a.style?.strokeWidth ?? ANNOTATION_DEFAULTS.strokeWidth;
  ctx.lineJoin = radius > 0 ? 'round' : 'miter';
  ctx.stroke();
}

/** Width in image pixels of `text` set in CSS font `font`. */
export type TextMeasure = (text: string, font: string) => number;

/** Without a measuring callback a character is taken to be this fraction of the font size wide. */
const ESTIMATED_CHAR_WIDTH = 0.6;

export interface TextLayout {
  font: string;
  fontSize: number;
  lines: string[];
  lineHeight: number;
  padX: number;
  padY: number;
  /** The drawn block, anchored at the box's top-left corner: at least the box, grown to fit the text. */
  block: Box;
}

/**
 * Where a text annotation's block and lines go, shared by the renderer and the
 * editor's bounds and hit testing. `measure` gives real text widths; without it
 * the widest line is estimated at 0.6 * fontSize per character.
 */
export function textLayout(a: Annotation, measure?: TextMeasure): TextLayout {
  const lines = (a.text ?? '').split(/\r?\n/);
  const fontSize = a.style?.fontSize ?? ANNOTATION_DEFAULTS.fontSize;
  const font = `600 ${fontSize}px ${ANNOTATION_FONT}`;
  const lineHeight = 1.25 * fontSize;
  const padX = 0.5 * fontSize;
  const padY = 0.25 * fontSize;
  const b = normalizeBox(a.box);
  const width = (line: string): number =>
    measure ? measure(line, font) : line.length * ESTIMATED_CHAR_WIDTH * fontSize;
  const widest = Math.max(...lines.map(width));
  return {
    font,
    fontSize,
    lines,
    lineHeight,
    padX,
    padY,
    block: {
      x: b.x,
      y: b.y,
      w: Math.max(b.w, widest + 2 * padX),
      h: Math.max(b.h, lines.length * lineHeight + 2 * padY),
    },
  };
}

function drawText(ctx: Canvas2D, a: Annotation): void {
  if ((a.text ?? '') === '') return;
  const t = textLayout(a, (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  });
  ctx.font = t.font;

  // The text sits at the same place with or without the pill.
  if (a.style?.fill) {
    ctx.fillStyle = a.style.fill;
    roundedRect(ctx, t.block.x, t.block.y, t.block.w, t.block.h, Math.min(t.block.h / 2, 0.75 * t.fontSize));
    ctx.fill();
  }
  ctx.fillStyle = a.style?.color ?? ANNOTATION_DEFAULTS.color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  t.lines.forEach((line, i) => {
    ctx.fillText(line, t.block.x + t.padX, t.block.y + t.padY + (i + 0.5) * t.lineHeight);
  });
}

function drawStep(ctx: Canvas2D, a: Annotation, ordinal: number): void {
  const b = normalizeBox(a.box);
  const d = stepDiameter(a.box);
  const color = a.style?.color ?? ANNOTATION_DEFAULTS.color;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, 2 * Math.PI);
  ctx.fill();

  const trimmed = (a.text ?? '').trim();
  const label = trimmed === '' ? String(ordinal) : trimmed;
  let size = 0.55 * d;
  ctx.font = `700 ${size}px ${ANNOTATION_FONT}`;
  const width = ctx.measureText(label).width;
  if (width > 0.8 * d) {
    size *= (0.8 * d) / width;
    ctx.font = `700 ${size}px ${ANNOTATION_FONT}`;
  }
  ctx.fillStyle = labelColor(color);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy);
}

/** White or near-black, whichever contrasts more with `background` (WCAG relative luminance). */
function labelColor(background: string): string {
  const c = parseHex(background);
  if (!c) return '#ffffff';
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const dark = 0.2126 * lin(0x11) + 0.7152 * lin(0x18) + 0.0722 * lin(0x27);
  const contrastWhite = 1.05 / (lum + 0.05);
  const contrastDark = (lum + 0.05) / (dark + 0.05);
  return contrastWhite >= contrastDark ? '#ffffff' : DARK_LABEL;
}
