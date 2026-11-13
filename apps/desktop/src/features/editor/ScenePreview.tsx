import { outputSize, render, type Scene } from '@cropa/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewGeometry } from './annotate/geometry.ts';
import { createRedactionCache } from './redaction-cache.ts';
import { renderEnv } from './render-env.ts';

interface Props {
  scene: Scene;
  bitmap: ImageBitmap;
  /** Drawn over the canvas, in a layer with exactly its CSS box. */
  overlay?: (geometry: PreviewGeometry) => ReactNode;
}

interface Box {
  width: number;
  height: number;
}

/** The largest box with the aspect of `output` that fits in `available`. */
function fit(output: Box, available: Box): Box {
  const scale = Math.min(available.width / output.width, available.height / output.height);
  return {
    width: Math.max(1, Math.floor(output.width * scale)),
    height: Math.max(1, Math.floor(output.height * scale)),
  };
}

/** Draws the scene with the shared renderer, at most once per animation frame. */
export function ScenePreview({ scene, bitmap, overlay }: Props) {
  const { t } = useTranslation();
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [area, setArea] = useState<Box>({ width: 0, height: 0 });
  const [device, setDevice] = useState<Box>();
  const env = useMemo(() => renderEnv(bitmap), [bitmap]);
  // Blur and pixelate are costly to recompute, so the preview keeps their result
  // between frames; export renders the full scene without it.
  const redactions = useRef(createRedactionCache());

  useLayoutEffect(() => {
    const element = areaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setArea({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, []);

  // The size in device pixels, so the backing store matches the screen exactly at
  // fractional scaling. It also updates when the window moves to another monitor.
  useLayoutEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.devicePixelContentBoxSize[0];
      if (size) setDevice({ width: size.inlineSize, height: size.blockSize });
    });
    observer.observe(element, { box: 'device-pixel-content-box' });
    return () => { observer.disconnect(); };
  }, []);

  const margin = area.width < 480 || area.height < 360 ? 16 : 32;
  const size = outputSize(scene, 1);
  const css = fit(size, {
    width: Math.max(1, area.width - 2 * margin),
    height: Math.max(1, area.height - 2 * margin),
  });
  // The device size lags one observer callback behind a new CSS size (for example
  // after an aspect change); until it catches up, estimate from the pixel ratio so
  // the preview is never drawn stretched.
  const dpr = window.devicePixelRatio;
  const estimate = { width: Math.round(css.width * dpr), height: Math.round(css.height * dpr) };
  const current =
    device &&
    Math.abs(device.width - estimate.width) <= 1 &&
    Math.abs(device.height - estimate.height) <= 1
      ? device
      : estimate;
  const backingW = Math.max(1, current.width);
  const backingH = Math.max(1, current.height);

  useEffect(() => {
    if (area.width === 0) return;
    const frame = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const start = performance.now();
      // Resizing the backing store clears it, so it is only done when the size changed.
      if (canvas.width !== backingW) canvas.width = backingW;
      if (canvas.height !== backingH) canvas.height = backingH;
      const cached = redactions.current.scene(scene, env);
      render(cached.scene, 0, ctx, cached.env);
      performance.clearMeasures('cropa:preview-render');
      performance.measure('cropa:preview-render', { start, end: performance.now() });
    });
    return () => { cancelAnimationFrame(frame); };
  }, [scene, env, backingW, backingH, area.width]);

  return (
    <div ref={areaRef} className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
      <div className="relative" style={{ width: css.width, height: css.height }}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={t('editor.previewAlt')}
          className="checkerboard"
          style={{ width: css.width, height: css.height }}
        />
        {overlay?.({ css, backing: { width: backingW, height: backingH } })}
      </div>
    </div>
  );
}
