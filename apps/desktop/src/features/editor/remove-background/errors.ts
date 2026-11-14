import type { TFunction } from 'i18next';

import type { CutoutError } from '../../../lib/bindings.ts';
import type { UserError } from '../../../lib/errors.ts';
import { MAX_SEND_BYTES } from './rules.ts';

function render(t: TFunction, kind: string, vars: Record<string, string>): UserError {
  return {
    what: t(`removeBackground.errors.${kind}.what`, vars),
    why: t(`removeBackground.errors.${kind}.why`, vars),
    next: t(`removeBackground.errors.${kind}.next`, vars),
  };
}

/** The picture is over what an AI turn accepts, so nothing was sent. */
export function describeImageTooLarge(t: TFunction): UserError {
  return render(t, 'ImageTooLarge', { limit: String(MAX_SEND_BYTES / (1024 * 1024)) });
}

/**
 * What the user is told when Rust could not make or keep the cut-out. `null` for
 * `ImageChanged`: the image was replaced while it ran, so the result is dropped without a word.
 */
export function describeCutoutError(t: TFunction, error: CutoutError): UserError | null {
  if (error.kind === 'ImageChanged') return null;
  return render(t, error.kind, { detail: 'detail' in error && typeof error.detail === 'string' ? error.detail : '' });
}
