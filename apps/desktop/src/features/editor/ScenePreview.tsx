import { frameGeometry, outputSize, render, type Scene } from '@cropa/core';
import { cn } from '@cropa/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { shotRectCss, type PreviewGeometry } from './annotate/geometry.ts';
import {
  closeCodeFrames,
  codeEnv,
  codeLayerOf,
  codePalette,
  createCodeFrameSource,
  type CodeFrames,
  type CodeFrameSource,
} from './code-frames.ts';
import { onAiBackgroundReveal, revealSharp, settleIn, workingSweep } from './preview-motion.ts';
import { createRedactionCache } from './redaction-cache.ts';
import { renderEnv } from './render-env.ts';

interface Props {
  scene: Scene;
  bitmap: ImageBitmap;
  /** Drawn over the canvas, in a layer with exactly its CSS box. */
  overlay?: (geometry: PreviewGeometry) => ReactNode;
  /** Space kept free under the image, in CSS px, for toolbars floating over the bottom of the canvas. */
  bottomInset?: number;
  /** The AI is writing a background: light sweeps over the screenshot until the result shows. */
  working?: boolean;
}

/** How long an applied AI background may take to draw its first frame before the reveal is dropped. */
const REVEAL_WAIT_MS = 15_000;
/** The veil's fade, in and out. */
const VEIL_FADE_MS = 200;

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
export function ScenePreview({ scene, bitmap, overlay, bottomInset = 0, working = false }: Props) {
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
  // When the newest AI background was applied, from then until its first frame is drawn or the
  // reveal is dropped: the canvas keeps the previous picture meanwhile. A time rather than a flag,
  // so a second request during the wait is seen as new.
  const [holdingSince, setHoldingSince] = useState<number | null>(null);
  const holding = holdingSince !== null;
  const dropReveal = useCallback(() => {
    revealPending.current = null;
    setHoldingSince(null);
  }, []);

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
        if (!source) {
          if (!cancelled()) dropReveal();
          return;
        }
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
        if (!cancelled()) dropReveal();
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
  }, [codeText, dropReveal]);

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
  // asynchronously, so the canvas keeps the picture it had until the first frame drawn from that
  // code, which then plays the reveal: `target` is the code text the scene moved to with the
  // request. The request comes in the same update as the scene it applies, so code that did not
  // change, moving to other code, a source that fails to load, or 15 s without a frame drop it.
  const codeTextNow = useRef(codeText);
  useEffect(() => { codeTextNow.current = codeText; });
  useEffect(() => {
    const pending = revealPending.current;
    if (!pending) return;
    if (performance.now() - pending.at > REVEAL_WAIT_MS) dropReveal();
    else if (pending.target === undefined) {
      if (codeText === undefined || codeText === pending.from) dropReveal();
      else revealPending.current = { ...pending, target: codeText };
    } else if (pending.target !== codeText) dropReveal();
  }, [codeText, holdingSince, dropReveal]);
  useEffect(
    () =>
      onAiBackgroundReveal(() => {
        const at = performance.now();
        revealPending.current = { from: codeTextNow.current, at };
        setHoldingSince(at);
      }),
    [],
  );
  useEffect(() => {
    if (holdingSince === null) return;
    const timer = setTimeout(dropReveal, REVEAL_WAIT_MS);
    return () => { clearTimeout(timer); };
  }, [holdingSince, dropReveal]);

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
  const geometry: PreviewGeometry = { css, backing: { width: backingW, height: backingH } };
  const shot = shotRectCss(scene, geometry);

  useEffect(() => {
    if (area.width === 0 || live) return;
    const frame = requestAnimationFrame(() => {
      // The applied AI background has no frame yet: drawing it now would show only the layers under
      // its code. The previous picture stays until the code draws.
      if (codeText !== undefined && revealPending.current?.target === codeText) return;
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
  }, [scene, env, backingW, backingH, area.width, live, codeText, holding]);

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
        dropReveal();
        if (performance.now() - pending.at < REVEAL_WAIT_MS) revealSharp(canvas);
      }
    };

    const fail = () => {
      if (stopped) return;
      stopped = true;
      console.error('The code layer stopped: a frame could not be rendered');
      dropReveal();
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
  }, [scene, env, backingW, backingH, area.width, live, durationMs, palette, codeText, dropReveal]);

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
          aria-busy={working || holding}
          className="checkerboard rounded-xl"
          style={{ width: css.width, height: css.height }}
        />
        <WorkingVeil
          on={working || holding}
          rect={shot}
          radius={scene.frame.radius * (shot.w / scene.screenshot.width)}
        />
        {overlay?.(geometry)}
      </div>
    </div>
  );
}

interface VeilProps {
  on: boolean;
  /** The screenshot's rectangle in CSS px, relative to the preview canvas. */
  rect: { x: number; y: number; w: number; h: number };
  radius: number;
}

/**
 * Plays over the screenshot while the AI works: a light veil with a band of light sweeping across
 * it. It is page chrome over the canvas, so it never reaches an exported image. It fades in, and
 * fades out once `on` turns off, staying mounted through the fade.
 */
function WorkingVeil({ on, rect, radius }: VeilProps) {
  const bandRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(on);
  if (on && !mounted) setMounted(true);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // One frame later both ways: the fade-in starts from a painted 0, and an `on` that turns off
    // and back on at once (a result handing over to its reveal) does not blink.
    if (on) {
      const frame = requestAnimationFrame(() => { setVisible(true); });
      return () => { cancelAnimationFrame(frame); };
    }
    const frame = requestAnimationFrame(() => { setVisible(false); });
    const timer = setTimeout(() => { setMounted(false); }, VEIL_FADE_MS + 50);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [on]);

  useEffect(() => {
    const band = bandRef.current;
    if (!mounted || !band) return;
    const sweep = workingSweep(band);
    return () => { sweep?.cancel(); };
  }, [mounted]);

  if (!mounted) return null;
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute overflow-hidden bg-white/10 transition-opacity duration-200 ease-enter',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, borderRadius: radius }}
    >
      <div
        ref={bandRef}
        className="absolute inset-y-0 left-0 w-1/2"
        style={{
          // `transform`, not Tailwind's `translate`, which would add to the sweep's own transform.
          transform: 'translateX(-100%)',
          background: 'linear-gradient(100deg, transparent 15%, rgb(255 255 255 / 0.3) 50%, transparent 85%)',
        }}
      />
    </div>
  );
}
