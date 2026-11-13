import type { BackgroundSpec, PresetError } from '@cropa/core';

export type PresetFileProblem =
  | { kind: 'PresetFileTooLarge'; limitKb: number }
  | { kind: 'PresetFileNotJson' }
  | { kind: 'PresetFileInvalid'; detail: string }
  | { kind: 'PresetFileTooNew' }
  | { kind: 'PresetFileHasCode' }
  /** Raised on export, when a preset has nothing but an AI-written background. */
  | { kind: 'PresetExportOnlyCode' };

/** What went wrong with a preset file, in the terms of the message shown to the user. */
export function presetFileProblem(error: PresetError): PresetFileProblem {
  switch (error.kind) {
    case 'too-large':
      return { kind: 'PresetFileTooLarge', limitKb: Math.round(error.limit / 1024) };
    case 'not-json':
      return { kind: 'PresetFileNotJson' };
    case 'invalid':
      return { kind: 'PresetFileInvalid', detail: error.issues.slice(0, 3).join('; ') };
    case 'too-new':
      return { kind: 'PresetFileTooNew' };
    case 'has-code':
      return { kind: 'PresetFileHasCode' };
  }
}

/** True for a background with an AI-written code layer: its tile shows an AI badge. */
export function isAiPreset(background: BackgroundSpec): boolean {
  return background.layers.some((layer) => layer.type === 'code');
}

export type PresetCategory = 'ai' | 'mine' | 'gradients' | 'images';
export const PRESET_CATEGORIES: readonly PresetCategory[] = ['ai', 'mine', 'gradients', 'images'];

/** Each preset belongs to exactly one category, decided in this order. */
export function presetCategory(background: BackgroundSpec, own: boolean): PresetCategory {
  if (isAiPreset(background)) return 'ai';
  if (own) return 'mine';
  if (background.layers.some((layer) => layer.type === 'image')) return 'images';
  return 'gradients';
}
