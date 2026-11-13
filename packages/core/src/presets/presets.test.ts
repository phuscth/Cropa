import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BACKGROUND_VERSION } from '../schema/background.ts';
import type { BackgroundSpec } from '../schema/background.ts';
import { builtinPresets } from './builtin.ts';
import { PRESET_MAX_BYTES, exportPreset, importPreset, presetId, presetName } from './file.ts';
import { BUILTIN_IMAGES, communityPresetProblems } from './images.ts';

const PRESETS_DIR = join(import.meta.dirname, '../../../../presets');

const spec: BackgroundSpec = {
  version: BACKGROUND_VERSION,
  viewBox: [0, 0, 1000, 1000],
  layers: [
    {
      type: 'linear',
      angle: 135,
      stops: [
        { offset: 0, color: '#ff8a7a' },
        { offset: 1, color: '#ffc371' },
      ],
    },
  ],
  animation: { type: 'none', speed: 1, loop: true, durationMs: 4000 },
};
const meta = { id: 'warm', name: { en: 'Warm', vi: 'Ấm' } };

function exported(): string {
  const result = exportPreset(spec, meta);
  if (!result.ok) throw new Error('export failed');
  return result.value;
}

describe('built-in presets', () => {
  const files = readdirSync(PRESETS_DIR).filter((name) => name.endsWith('.json'));

  it('lists every file of the presets folder', () => {
    expect(builtinPresets.map((p) => `${p.id}.json`).sort()).toEqual([...files].sort());
  });

  it('has unique ids', () => {
    const ids = builtinPresets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names every preset in both languages', () => {
    for (const preset of builtinPresets) expect(preset.name.vi).toBeDefined();
  });
});

describe('preset files', () => {
  it('round-trips through export and import', () => {
    const imported = importPreset(exported());
    expect(imported).toEqual({ ok: true, value: { version: 1, ...meta, background: spec } });
  });

  it('rejects text that is not JSON', () => {
    expect(importPreset('{ nope')).toEqual({ ok: false, error: { kind: 'not-json' } });
  });

  it('counts the size in bytes, not characters', () => {
    // 6000 characters of 3 bytes each: under the limit as characters, over it as bytes.
    const text = `"${'あ'.repeat(6000)}"`;
    const result = importPreset(text);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'too-large', bytes: 18002, limit: PRESET_MAX_BYTES },
    });
  });

  it('rejects a newer file version', () => {
    const doc = JSON.parse(exported()) as Record<string, unknown>;
    const result = importPreset(JSON.stringify({ ...doc, version: 2 }));
    expect(result).toEqual({ ok: false, error: { kind: 'too-new', version: 2, supported: 1 } });
  });

  it('rejects a newer background version', () => {
    const doc = JSON.parse(exported()) as { background: Record<string, unknown> };
    const result = importPreset(JSON.stringify({ ...doc, background: { ...doc.background, version: 3 } }));
    expect(result).toEqual({
      ok: false,
      error: { kind: 'too-new', version: 3, supported: BACKGROUND_VERSION },
    });
  });

  it('prefixes the path of an invalid background', () => {
    const doc = JSON.parse(exported()) as { background: { layers: Record<string, unknown>[] } };
    const layer = { ...doc.background.layers[0], angle: 9999 };
    const bad = { ...doc, background: { ...doc.background, layers: [layer] } };
    const result = importPreset(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    const error = result.ok ? undefined : result.error;
    expect(error?.kind).toBe('invalid');
    const issues = error?.kind === 'invalid' ? error.issues : [];
    expect(issues.some((i) => i.startsWith('background.layers.0.angle: '))).toBe(true);
  });

  it('round-trips an image layer, including a ref this build does not know', () => {
    for (const ref of ['builtin:silk', 'builtin:capture', 'builtin:from-a-newer-cropa', 'user:img-1f']) {
      const withImage = {
        ...spec,
        layers: [{ type: 'image', ref, fit: 'cover' }, { type: 'blur', radius: 12 }],
      } as BackgroundSpec;
      const text = exportPreset(withImage, meta);
      expect(text.ok).toBe(true);
      const back = text.ok ? importPreset(text.value) : text;
      expect(back.ok && back.value.background.layers).toEqual(withImage.layers);
    }
  });

  it('still rejects a malformed image ref', () => {
    const bad = { ...spec, layers: [{ type: 'image', ref: 'file:C:/x.png', fit: 'cover' }] };
    expect(exportPreset(bad as unknown as BackgroundSpec, meta).ok).toBe(false);
  });

  it('rejects every control character in a name', () => {
    for (const name of ['two\nlines', 'tab\there', 'del\u007f', 'c1\u0085']) {
      expect(exportPreset(spec, { id: 'warm', name: { en: name } }).ok).toBe(false);
    }
  });

  it('rejects an unknown key', () => {
    const doc = JSON.parse(exported()) as Record<string, unknown>;
    const result = importPreset(JSON.stringify({ ...doc, author: 'x' }));
    expect(result.ok).toBe(false);
  });

  it('refuses to export a bad id', () => {
    expect(exportPreset(spec, { ...meta, id: 'Not Valid' }).ok).toBe(false);
  });

  it('refuses to export a spec over the size limit', () => {
    const points = Array.from({ length: 12 }, (_, i) => ({
      x: 100.123456789012 + i,
      y: 200.123456789012 + i,
      r: 300.123456789012,
      color: '#aabbcc',
    }));
    const big: BackgroundSpec = {
      ...spec,
      layers: Array.from({ length: 16 }, () => ({ type: 'mesh' as const, points })),
    };
    const result = exportPreset(big, meta);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('too-large');
  });
});

describe('presetId', () => {
  it('makes a slug from a Vietnamese name', () => {
    expect(presetId('Hoàng hôn Đà Lạt')).toBe('hoang-hon-da-lat');
  });

  it('falls back when nothing usable is left', () => {
    expect(presetId('')).toBe('preset');
    expect(presetId('🌅')).toBe('preset');
  });

  it('cuts a long name without a trailing dash', () => {
    const id = presetId(`${'a'.repeat(39)} bbbb`);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id.endsWith('-')).toBe(false);
  });
});

describe('presetName', () => {
  it('prefers Vietnamese for vi and falls back to English', () => {
    expect(presetName({ name: { en: 'Warm', vi: 'Ấm' } }, 'vi')).toBe('Ấm');
    expect(presetName({ name: { en: 'Warm' } }, 'vi')).toBe('Warm');
    expect(presetName({ name: { en: 'Warm', vi: 'Ấm' } }, 'en')).toBe('Warm');
  });
});

describe('community preset images', () => {
  const withRef = (ref: string): { background: BackgroundSpec } => ({
    background: { ...spec, layers: [{ type: 'image', ref, fit: 'cover' }] },
  });

  it('allows the built-in images and the screenshot', () => {
    for (const name of [...BUILTIN_IMAGES, 'capture']) {
      expect(communityPresetProblems(withRef(`builtin:${name}`))).toEqual([]);
    }
    expect(communityPresetProblems({ background: spec })).toEqual([]);
  });

  it('refuses a user image and an unknown built-in name', () => {
    expect(communityPresetProblems(withRef('user:img-1f'))).toHaveLength(1);
    expect(communityPresetProblems(withRef('builtin:unknown'))).toHaveLength(1);
  });

  it('refuses a code layer', () => {
    const withCode = {
      background: {
        ...spec,
        layers: [...spec.layers, { type: 'code' as const, source: 'export default {}', durationMs: 4000 }],
      },
    };
    expect(communityPresetProblems(withCode)).toEqual([
      expect.stringContaining('background.layers.1: a code layer'),
    ]);
  });
});
