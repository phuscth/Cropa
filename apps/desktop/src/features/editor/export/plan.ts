import { outputSize, outputSizeAtLongEdge, type Scene } from '@cropa/core';

import type { ExportFormat } from '../../../lib/bindings.ts';

/** `1x` is the canvas's own size; the K sizes fix the longer side of the output. */
export type ExportSize = '1x' | '2k' | '4k' | '6k';

export const EXPORT_SIZES: readonly ExportSize[] = ['1x', '2k', '4k', '6k'];

const LONG_EDGE = { '2k': 2560, '4k': 3840, '6k': 6144 } as const;

export interface ExportPlan {
  width: number;
  height: number;
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

export function exportPlan(scene: Scene, format: ExportFormat, size: ExportSize): ExportPlan {
  // A fixed pixel width (a platform size) is the file's width, whatever the size.
  const { width, height } =
    size === '1x' || scene.output.width !== null
      ? outputSize(scene, 1)
      : outputSizeAtLongEdge(scene, Math.min(LONG_EDGE[size], MAX_EXPORT_SIDE));
  return {
    width,
    height,
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
