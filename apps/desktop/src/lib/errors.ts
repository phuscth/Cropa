import type { TFunction } from 'i18next';

import type { CommandError } from './bindings.ts';

/** Every user-facing error has three parts: what happened, why, what to do next. */
export interface UserError {
  what: string;
  why: string;
  next: string;
}

type Vars = Record<string, string>;

function render(t: TFunction, kind: string, vars: Vars): UserError {
  return {
    what: t(`errors.${kind}.what`, vars),
    why: t(`errors.${kind}.why`, vars),
    next: t(`errors.${kind}.next`, vars),
  };
}

export function describeCommandError(t: TFunction, error: CommandError, vars: Vars = {}): UserError {
  const detail = 'detail' in error ? String(error.detail) : '';
  return render(t, error.kind, { ...vars, detail });
}

/** For failures that are not a typed `CommandError` (IPC, ACL, bugs). */
export function describeUnexpected(t: TFunction, cause: unknown): UserError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return render(t, 'Unexpected', { detail });
}
