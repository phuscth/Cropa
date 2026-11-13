import { z } from 'zod';

import { BackgroundSpec, migrateBackground } from '../schema/background.ts';
import { formatIssues, parseWith, prefixIssue, upgrade } from '../schema/migrate.ts';
import type { MigrateError, MigrateResult, UpgradeStep } from '../schema/migrate.ts';

export const PRESET_FILE_VERSION = 1;
/** The most a preset file may hold, as UTF-8 text. */
export const PRESET_MAX_BYTES = 16384;

const MAX_ID_LENGTH = 40;

export const PresetId = z
  .string()
  .min(2)
  .max(MAX_ID_LENGTH)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'expected lowercase words joined by single dashes');

const displayName = z
  .string()
  .min(1)
  .max(40)
  .refine((s) => !/\p{Cc}/u.test(s), 'must not contain control characters')
  .refine((s) => s === s.trim(), 'must not start or end with whitespace');

/** Display names by language. `en` is required, anything else falls back to it. */
export const PresetName = z.strictObject({ en: displayName, vi: displayName.optional() });
export type PresetName = z.infer<typeof PresetName>;

export const PresetFile = z.strictObject({
  version: z.literal(PRESET_FILE_VERSION),
  id: PresetId,
  name: PresetName,
  background: BackgroundSpec,
});
export type PresetFile = z.infer<typeof PresetFile>;
export type Preset = PresetFile;

export type PresetError =
  | MigrateError
  | { kind: 'not-json' }
  | { kind: 'too-large'; bytes: number; limit: number };

export type PresetResult<T> = { ok: true; value: T } | { ok: false; error: PresetError };

/** `steps[v]` upgrades version `v` to `v + 1`. Empty until a second version exists. */
const steps: Record<number, UpgradeStep> = {};

export function migratePresetFile(input: unknown): MigrateResult<PresetFile> {
  const upgraded = upgrade(input, PRESET_FILE_VERSION, steps);
  if (!upgraded.ok) return upgraded;
  const doc = { ...upgraded.value };
  const issues: string[] = [];

  if ('background' in doc) {
    const nested = migrateBackground(doc.background);
    if (nested.ok) doc.background = nested.value;
    else if (nested.error.kind === 'too-new') return nested;
    else issues.push(...nested.error.issues.map((i) => prefixIssue('background', i)));
  }
  if (issues.length > 0) {
    // The other fields are still checked, so one pass shows every problem.
    const rest = { ...doc };
    delete rest.background;
    const others = PresetFile.omit({ background: true }).safeParse(rest);
    if (!others.success) issues.unshift(...formatIssues(others.error));
    return { ok: false, error: { kind: 'invalid', issues } };
  }
  return parseWith(PresetFile, doc);
}

/** UTF-8 length of `text` in bytes. Core has no `TextEncoder` typings, so count code points. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Reads the text of a preset file: size first, then JSON, then the schema. */
export function importPreset(text: string): PresetResult<Preset> {
  const bytes = utf8Length(text);
  if (bytes > PRESET_MAX_BYTES) {
    return { ok: false, error: { kind: 'too-large', bytes, limit: PRESET_MAX_BYTES } };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: { kind: 'not-json' } };
  }
  return migratePresetFile(data);
}

/** The text of a preset file for `spec`. What it returns always passes {@link importPreset}. */
export function exportPreset(
  spec: BackgroundSpec,
  meta: { id: string; name: PresetName },
): PresetResult<string> {
  const checked = migratePresetFile({
    version: PRESET_FILE_VERSION,
    id: meta.id,
    name: meta.name,
    background: spec,
  });
  if (!checked.ok) return checked;
  const text = `${JSON.stringify(checked.value, null, 2)}\n`;
  const bytes = utf8Length(text);
  if (bytes > PRESET_MAX_BYTES) {
    return { ok: false, error: { kind: 'too-large', bytes, limit: PRESET_MAX_BYTES } };
  }
  return { ok: true, value: text };
}

/** A file-safe id for a preset a user named, e.g. "Hoàng hôn" becomes "hoang-hon". */
export function presetId(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/, '');
  return slug.length < 2 ? 'preset' : slug;
}

/** The name to show in `lang`: Vietnamese when asked for and present, English otherwise. */
export function presetName(preset: Pick<Preset, 'name'>, lang: string): string {
  return lang === 'vi' && preset.name.vi !== undefined ? preset.name.vi : preset.name.en;
}
