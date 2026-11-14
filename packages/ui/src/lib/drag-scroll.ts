/** How far, in CSS pixels, a press must move before it counts as a drag instead of a click. */
export const DRAG_THRESHOLD = 5;

/**
 * How long, in milliseconds, a row keeps gliding at the speed it was let go with. The glide
 * picks which snap point the row settles on, so a quick flick moves it a card or two further.
 */
export const GLIDE_MS = 160;

/** Whether a press that has moved by (`dx`, `dy`) is a drag: past the threshold in any direction. */
export function isDrag(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  return Math.hypot(dx, dy) > threshold;
}

/**
 * Where a dragged row comes to rest: its position carried on by the release speed (pointer
 * pixels per millisecond, positive when the pointer moved right), then moved to the nearest
 * snap point and kept within `0..max`. With no snap points it rests where the glide ends.
 */
export function restingScroll(
  scrollLeft: number,
  velocity: number,
  snaps: readonly number[],
  max: number,
): number {
  const glided = scrollLeft - velocity * GLIDE_MS;
  let target = glided;
  let best = Infinity;
  for (const snap of snaps) {
    const distance = Math.abs(snap - glided);
    if (distance < best) {
      best = distance;
      target = snap;
    }
  }
  return Math.min(Math.max(target, 0), Math.max(max, 0));
}
