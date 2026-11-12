/**
 * Clamp `value` into `[min, max]`. NaN maps to `min` so untrusted input
 * (AI output, files on disk) can never leak NaN into the renderer.
 */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`clamp: min (${min}) is greater than max (${max})`);
  }
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
