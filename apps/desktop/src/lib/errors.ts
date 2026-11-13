import type { TFunction } from 'i18next';

import type { CommandError, ExportFormat } from './bindings.ts';
import type { PresetFileProblem } from '../features/editor/presets/preset-file.ts';

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

/** The editor could not decode the capture it was given. */
export function describeEditorImage(t: TFunction, cause: unknown): UserError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return render(t, 'EditorImage', { detail });
}

/** An edit was refused because the image would exceed the output size limit. */
export function describeOutputTooLarge(t: TFunction): UserError {
  return render(t, 'OutputTooLarge', {});
}

/** The WebView returned a different type than the one asked for, so it can't encode this format. */
export class ExportEncodeError extends Error {
  readonly format: ExportFormat;

  constructor(format: ExportFormat) {
    super(`The WebView cannot encode ${format}`);
    this.name = 'ExportEncodeError';
    this.format = format;
  }
}

/** A new capture replaced the editor's image while the Save as dialog was open. */
export function describeExportImageChanged(t: TFunction): UserError {
  return render(t, 'ExportImageChanged', {});
}

/** Drawing or encoding the exported image failed. */
export function describeExport(t: TFunction, cause: unknown): UserError {
  if (cause instanceof ExportEncodeError) {
    return render(t, 'ExportFormatUnsupported', { format: cause.format.toUpperCase() });
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return render(t, 'ExportRender', { detail });
}

/** A preset file the user picked could not be imported. */
export function describePresetFile(t: TFunction, problem: PresetFileProblem): UserError {
  const { kind } = problem;
  if (problem.kind === 'PresetFileTooLarge') return render(t, kind, { limit: String(problem.limitKb) });
  if (problem.kind === 'PresetFileInvalid') return render(t, kind, { detail: problem.detail });
  return render(t, kind, {});
}
