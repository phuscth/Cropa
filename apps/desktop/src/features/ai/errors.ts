import type { AiErrorKind } from '@cropa/ai';
import type { TFunction } from 'i18next';

import type { UserError } from '../../lib/errors.ts';

/** What the user is told when an AI run ends on its fallback: what, why, what next. */
export function describeAiError(t: TFunction, kind: AiErrorKind, providerName: string): UserError {
  const vars = { provider: providerName };
  return {
    what: t(`aiErrors.${kind}.what`, vars),
    why: t(`aiErrors.${kind}.why`, vars),
    next: t(`aiErrors.${kind}.next`, vars),
  };
}
