import { outputSize, type Scene } from '@cropa/core';

import type { ExportFormat } from '../../../lib/bindings.ts';

export type ExportScale = 1 | 2;

export interface ExportPlan {
  width: number;
  height: number;
  /** The scale actually used, which can be lower than the one asked for. */
  scale: number;
  mime: string;
  /** Encoder quality from 0 to 1; undefined for lossless PNG. */
  quality: number | undefined;
}

/** The longest side a canvas may have on every WebView2 build we support. */
export const MAX_EXPORT_SIDE = 16384;

const MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const LOSSY_QUALITY = 0.92;

export function exportPlan(scene: Scene, format: ExportFormat, scale: ExportScale): ExportPlan {
  const base = outputSize(scene, 1);
  // A fixed pixel width (a platform size) is the file's width, whatever the scale.
  const effective =
    scene.output.width !== null
      ? 1
      : Math.max(1, Math.min(scale, MAX_EXPORT_SIDE / Math.max(base.width, base.height)));
  const { width, height } = outputSize(scene, effective);
  return {
    width,
    height,
    scale: effective,
    mime: MIME[format],
    quality: format === 'png' ? undefined : LOSSY_QUALITY,
  };
}

const pad = (value: number) => String(value).padStart(2, '0');

/** `Cropa YYYY-MM-DD HH.MM.SS` in local time, the stem quick saves use too. */
export function captureFileStem(ms: number): string {
  const d = new Date(ms);
  const date = `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  return `Cropa ${date} ${time}`;
}
