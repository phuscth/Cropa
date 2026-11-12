import { exportPreset, migrateBackground, presetId } from '@cropa/core';
import type { BackgroundSpec } from '@cropa/core';

import { commands } from './bindings.ts';
import type { CommandError } from './bindings.ts';

export type Result<T> = { status: 'ok'; data: T } | { status: 'error'; error: CommandError };

/** A background the user saved under a name. */
export interface SavedPreset {
  id: string;
  name: string;
  background: BackgroundSpec;
}

/**
 * The user's saved presets. An entry whose background no longer passes the schema
 * (a file edited by hand, or written by a newer build) is not returned in `presets`
 * but in `unreadable`: it still counts toward the limit of 200 in Rust, so a UI
 * can show it and let the user delete it.
 */
export async function listUserPresets(): Promise<
  Result<{ presets: SavedPreset[]; unreadable: { id: string; name: string }[] }>
> {
  const result = await commands.listUserPresets();
  if (result.status === 'error') return result;
  const presets: SavedPreset[] = [];
  const unreadable: { id: string; name: string }[] = [];
  for (const entry of result.data) {
    const checked = migrateBackground(entry.background);
    if (checked.ok) presets.push({ id: entry.id, name: entry.name, background: checked.value });
    else unreadable.push({ id: entry.id, name: entry.name });
  }
  return { status: 'ok', data: { presets, unreadable } };
}

/** Adds a preset, or replaces the one with `id`. The background is checked before Rust sees it. */
export async function saveUserPreset(preset: {
  id?: string;
  name: string;
  background: unknown;
}): Promise<Result<SavedPreset>> {
  const checked = migrateBackground(preset.background);
  if (!checked.ok) {
    const detail =
      checked.error.kind === 'invalid'
        ? checked.error.issues.join('; ')
        : `version ${checked.error.version} is newer than the supported ${checked.error.supported}`;
    return { status: 'error', error: { kind: 'UserPresetInvalid', detail } };
  }
  // A saved preset must also be exportable as a file, which has its own size limit.
  const name = preset.name.trim();
  const exported = exportPreset(checked.value, { id: presetId(name), name: { en: name } });
  if (!exported.ok) {
    const { error } = exported;
    if (error.kind === 'too-large') return { status: 'error', error: { kind: 'UserPresetTooLarge' } };
    if (error.kind === 'invalid') {
      return error.issues.some((i) => i.startsWith('name'))
        ? { status: 'error', error: { kind: 'UserPresetName' } }
        : { status: 'error', error: { kind: 'UserPresetInvalid', detail: error.issues.join('; ') } };
    }
    return { status: 'error', error: { kind: 'UserPresetInvalid', detail: error.kind } };
  }
  const result = await commands.saveUserPreset(preset.id ?? null, preset.name, checked.value);
  if (result.status === 'error') return result;
  return {
    status: 'ok',
    data: { id: result.data.id, name: result.data.name, background: checked.value },
  };
}

export function deleteUserPreset(id: string): Promise<Result<null>> {
  return commands.deleteUserPreset(id);
}
