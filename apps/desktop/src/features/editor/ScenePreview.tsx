import { frameGeometry, outputSize, render, type Scene } from '@cropa/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewGeometry } from './annotate/geometry.ts';
import {
  closeCodeFrames,
  codeEnv,
  codeLayerOf,
  codePalette,
  createCodeFrameSource,
  type CodeFrames,
  type CodeFrameSource,
} from './code-frames.ts';
import { onAiBackgroundReveal, revealSharp, settleIn } from './preview-motion.ts';
import { createRedactionCache } from './redaction-cache.ts';
import { renderEnv } from './render-env.ts';

interface Props {
  scene: Scene;
  bitmap: ImageBitmap;
  /** Drawn over the canvas, in a layer with exactly its CSS box. */
  overlay?: (geometry: PreviewGeometry) => ReactNode;
  /** Space kept free under the image, in CSS px, for toolbars floating over the bottom of the canvas. */
  bottomInset?: number;
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
export function ScenePreview({ scene, bitmap, overlay, bottomInset = 0 }: Props) {
  const { t } = useTranslation();
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Box>({ width: 0, height: 0 });
  const [device, setDevice] = useState<Box>();
  const env = useMemo(() => renderEnv(bitmap), [bitmap]);
  // Blur and pixelate are costly to recompute, so the preview keeps their result
  // between frames; export renders the full scene without it.
  const redactions = useRef(createRedactionCache());
  // See the reveal effects below.
  const revealPending = useRef<{ from: string | undefined; at: number; target?: string | undefined } | null>(null);

  // A code layer animates: its source runs in the sandbox and the preview draws one
  // bitmap pair per animation frame. Without a sandbox in this build, or after a
  // failure, the layer draws nothing and the static path below draws the fallback.
  const codeLayer = codeLayerOf(scene);
  const codeText = codeLayer?.source;
  const durationMs = codeLayer?.durationMs ?? 0;
  // Read from the screenshot once per image, and only when there is a code layer to give it to.
  const hasCode = codeText !== undefined;
  const palette = useMemo(() => (hasCode ? codePalette(bitmap) : []), [hasCode, bitmap]);
  const [loaded, setLoaded] = useState<{ source: CodeFrameSource; text: string } | null>(null);
  // A source loaded for an earlier text counts as absent until the new one is ready.
  const live = loaded && loaded.text === codeText ? loaded.source : null;
  const lastFrames = useRef<CodeFrames | null>(null);
  // Animation time survives a redraw of the scene, so editing does not restart it.
  const clock = useRef<number>(undefined);
  // When the animation loop last stopped, so a pause (the view hidden) does not skip time.
  const stoppedAt = useRef<number>(undefined);

  useEffect(() => {
    if (codeText === undefined) return;
    const held: { alive: boolean; source: CodeFrameSource | null } = { alive: true, source: null };
    const cancelled = () => !held.alive;
    void (async () => {
      try {
        const source = await createCodeFrameSource(codeText);
        if (!source) return;
        if (cancelled()) {
          source.dispose();
          return;
        }
        held.source = source;
        await source.load(codeText);
        if (cancelled()) {
          source.dispose();
          held.source = null;
          return;
        }
        setLoaded({ source, text: codeText });
      } catch {
        console.error('The code layer could not be loaded');
        revealPending.current = null;
        held.source?.dispose();
        held.source = null;
      }
    })();
    return () => {
      held.alive = false;
      setLoaded(null);
      held.source?.dispose();
      closeCodeFrames(lastFrames.current);
      lastFrames.current = null;
    };
  }, [codeText]);

  // A new screenshot settles in; the first one does too, when the preview mounts.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    // The box is scaled while it settles, so the pointer would map a little off: it waits.
    frame.style.pointerEvents = 'none';
    const release = () => { frame.style.pointerEvents = ''; };
    settleIn(frame).finished.then(release, release);
  }, [bitmap]);

  // An applied AI background is revealed from a blur, on the canvas element only. Its code loads
  // asynchronously and the closest preset is drawn meanwhile, so the reveal waits for the first
  // frame drawn from that code: `target` is the code text the scene moves to after the request, and
  // only its first frame may play the reveal. Moving to other code, a source that fails to load, or
  // 15 s without a frame drops the request.
  const codeTextNow = useRef(codeText);
  useEffect(() => { codeTextNow.current = codeText; });
  useEffect(() => {
    const pending = revealPending.current;
    if (!pending || codeText === pending.from) return;
    if (performance.now() - pending.at > 15_000) revealPending.current = null;
    else if (pending.target === undefined) revealPending.current = { ...pending, target: codeText };
    else if (pending.target !== codeText) revealPending.current = null;
  }, [codeText]);
  useEffect(
    () =>
      onAiBackgroundReveal(() => {
        revealPending.current = { from: codeTextNow.current, at: performance.now() };
      }),
    [],
  );

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
    if (area.width === 0 || live) return;
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
  }, [scene, env, backingW, backingH, area.width, live]);

  useEffect(() => {
    if (area.width === 0 || !live) return;
    let stopped = false;
    // Local to this run, so a frame of an earlier source that never settles blocks nothing.
    let inFlight = false;
    let raf = 0;
    let hiddenAt: number | undefined;
    if (stoppedAt.current !== undefined && clock.current !== undefined) {
      clock.current += performance.now() - stoppedAt.current;
    }
    stoppedAt.current = undefined;

    const draw = (frames: CodeFrames | null, t: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const began = performance.now();
      if (canvas.width !== backingW) canvas.width = backingW;
      if (canvas.height !== backingH) canvas.height = backingH;
      const cached = redactions.current.scene(scene, env);
      render(cached.scene, t, ctx, codeEnv(cached.env, frames));
      performance.clearMeasures('cropa:preview-render');
      performance.measure('cropa:preview-render', { start: began, end: performance.now() });
      const pending = revealPending.current;
      if (pending && frames && codeText === pending.target) {
        revealPending.current = null;
        if (performance.now() - pending.at < 15_000) revealSharp(canvas);
      }
    };

    const fail = () => {
      if (stopped) return;
      stopped = true;
      console.error('The code layer stopped: a frame could not be rendered');
      revealPending.current = null;
      setLoaded(null);
    };

    const tick = (now: number) => {
      raf = 0;
      if (stopped) return;
      raf = requestAnimationFrame(tick);
      if (inFlight) return;
      clock.current ??= now;
      const elapsed = (now - clock.current) % durationMs;
      const t = elapsed >= 0 && elapsed < durationMs ? elapsed / durationMs : 0;
      inFlight = true;
      const geometry = { ...frameGeometry(scene, backingW, backingH), palette };
      live.renderFrame(t, geometry).then(
        (frames) => {
          inFlight = false;
          if (stopped) {
            closeCodeFrames(frames);
            return;
          }
          draw(frames, t);
          closeCodeFrames(lastFrames.current);
          lastFrames.current = frames;
        },
        () => {
          inFlight = false;
          fail();
        },
      );
    };

    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = performance.now();
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (raf === 0 && !stopped) {
        // Time continues from where it stopped instead of jumping ahead.
        if (hiddenAt !== undefined && clock.current !== undefined) {
          clock.current += performance.now() - hiddenAt;
        }
        hiddenAt = undefined;
        raf = requestAnimationFrame(tick);
      }
    };

    // Until the first new frame arrives, the previous one keeps the canvas from going blank.
    if (lastFrames.current) draw(lastFrames.current, 0);
    document.addEventListener('visibilitychange', onVisibility);
    if (document.hidden) onVisibility();
    else raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      stoppedAt.current = hiddenAt ?? performance.now();
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [scene, env, backingW, backingH, area.width, live, durationMs, palette, codeText]);

  return (
    <div
      ref={areaRef}
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-3 pt-3"
      style={{ paddingBottom: bottomInset }}
    >
      <div ref={frameRef} className="relative" style={{ width: css.width, height: css.height }}>
        <canvas
          ref={canvasRef}
          role="img"
          data-testid="editor-preview"
          aria-label={t('editor.previewAlt')}
          className="checkerboard"
          style={{ width: css.width, height: css.height }}
        />
        {overlay?.({ css, backing: { width: backingW, height: backingH } })}
      </div>
    </div>
  );
}
