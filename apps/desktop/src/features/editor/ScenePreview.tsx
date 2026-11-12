import { outputSize, render, type RenderEnv, type Scene } from '@cropa/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CAPTURE_REF } from './scene-edits.ts';

interface Props {
  scene: Scene;
  bitmap: ImageBitmap;
}

interface Box {
  width: number;
  height: number;
}

function createContext(width: number, height: number) {
  const ctx = new OffscreenCanvas(width, height).getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return ctx;
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
export function ScenePreview({ scene, bitmap }: Props) {
  const { t } = useTranslation();
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [area, setArea] = useState<Box>({ width: 0, height: 0 });
  const [device, setDevice] = useState<Box>();

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
      const env: RenderEnv = {
        screenshot: bitmap,
        image: (ref) => (ref === CAPTURE_REF ? bitmap : undefined),
        createContext,
      };
      render(scene, 0, ctx, env);
      performance.clearMeasures('cropa:preview-render');
      performance.measure('cropa:preview-render', { start, end: performance.now() });
    });
    return () => { cancelAnimationFrame(frame); };
  }, [scene, bitmap, backingW, backingH, area.width]);

  return (
    <div ref={areaRef} className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={t('editor.previewAlt')}
        className="checkerboard"
        style={{ width: css.width, height: css.height }}
      />
    </div>
  );
}
