import type { AiDetection } from '../../../lib/bindings.ts';
import { cliStatus } from '../../ai/providers.ts';

/** Why the button is off, in the order the user can fix them. */
export type LockReason = 'noImage' | 'checking' | 'needsCodex' | 'imagesOff';

/** Mirrors `MAX_ORIGINAL_PIXELS` in `crates/cropa-matte/src/lib.rs`: the most pixels the original may have. */
export const MAX_CUTOUT_PIXELS = 25_000_000;

/** Mirrors `MAX_IMAGE_BYTES` in `commands/ai.rs`: the most a picture sent to an AI turn may weigh. */
export const MAX_SEND_BYTES = 20 * 1024 * 1024;

/**
 * Codex can run the image turn: installed, signed in (or not known to be signed out), a version
 * Cropa was verified on, and it reports both image input and output.
 */
export function codexCanRemoveBackground(detection: AiDetection | undefined): boolean {
  return (
    detection !== undefined && cliStatus(detection) === 'ready' && detection.imageIn && detection.imageOut
  );
}

export interface LockInput {
  hasImage: boolean;
  /** Detection and the settings are still being read. */
  loading: boolean;
  codex: AiDetection | undefined;
  allowImages: boolean;
}

/** The first thing that keeps background removal from running, or null when it can run. */
export function removeBackgroundLock({ hasImage, loading, codex, allowImages }: LockInput): LockReason | null {
  if (!hasImage) return 'noImage';
  if (loading) return 'checking';
  if (!codexCanRemoveBackground(codex)) return 'needsCodex';
  if (!allowImages) return 'imagesOff';
  return null;
}

/** Whether the picture can be cut out at all, so no run is spent on one that cannot succeed. */
export function sendProblem(
  size: { width: number; height: number },
  bytes: number | null,
): 'tooManyPixels' | 'tooManyBytes' | null {
  if (size.width * size.height > MAX_CUTOUT_PIXELS) return 'tooManyPixels';
  if (bytes !== null && bytes > MAX_SEND_BYTES) return 'tooManyBytes';
  return null;
}

/** The size in bytes of the picture inside a base64 `data:` URL. */
export function dataUrlBytes(url: string): number {
  const body = url.slice(url.indexOf(',') + 1);
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return Math.floor((body.length * 3) / 4) - padding;
}

/** The base64 of a `data:` URL, as `applyCutout` and the transport take it. */
export function dataUrlBase64(url: string): string {
  return url.slice(url.indexOf(',') + 1);
}
