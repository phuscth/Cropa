/**
 * Motion of the preview that belongs to the page around the canvas, never to
 * the pixels the renderer draws: a new screenshot settling in, and an AI
 * background revealed from a blur. Both run as Web Animations on the DOM
 * elements, so an export is not affected.
 */

const EASE_ENTER = 'cubic-bezier(0.23, 1, 0.32, 1)';

const revealTarget = new EventTarget();
const REVEAL = 'reveal';

/** Asks for a reveal: an AI background has been applied, and the preview plays it once the new code draws. */
export function announceAiBackgroundReveal(): void {
  revealTarget.dispatchEvent(new Event(REVEAL));
}

/** Listens for an applied AI background; returns the cleanup. */
export function onAiBackgroundReveal(listener: () => void): () => void {
  revealTarget.addEventListener(REVEAL, listener);
  return () => { revealTarget.removeEventListener(REVEAL, listener); };
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A new screenshot: scale .97 to 1 and fade in over 280ms. Reduced motion only fades. */
export function settleIn(element: HTMLElement): Animation {
  const from = reducedMotion()
    ? { opacity: 0 }
    : { opacity: 0, transform: 'scale(0.97)' };
  return element.animate([from, { opacity: 1, transform: 'none' }], { duration: 280, easing: EASE_ENTER });
}

/** An AI background: blur 12px to 0 and opacity .6 to 1 over 400ms. Reduced motion cross-fades without blur. */
export function revealSharp(element: HTMLElement): void {
  const from = reducedMotion()
    ? { opacity: 0.6 }
    : { opacity: 0.6, filter: 'blur(12px)' };
  element.animate([from, { opacity: 1, filter: 'blur(0px)' }], { duration: 400, easing: EASE_ENTER });
}
