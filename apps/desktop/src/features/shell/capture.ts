import { commands } from '../../lib/bindings.ts';

const nextFrame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); });

/**
 * Starts a region capture once the window has repainted after the click that
 * asked for it: the capture photographs every monitor. Two frames let the
 * WebView paint, and a short wait lets the compositor put that frame on screen.
 */
export function requestCaptureAfterPaint() {
  return nextFrame()
    .then(nextFrame)
    .then(() => new Promise((resolve) => { setTimeout(resolve, 100); }))
    .then(() => commands.requestCapture());
}
