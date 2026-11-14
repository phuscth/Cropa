import { describe, expect, it } from 'vitest';

import { migrateAnnotation } from './annotation.ts';
import { BACKGROUND_VERSION, migrateBackground } from './background.ts';
import { annotationJsonSchema, backgroundJsonSchema, sceneJsonSchema } from './json-schema.ts';
import type { MigrateResult } from './migrate.ts';
import { defaultScene, migrateScene } from './scene.ts';

const background = () => defaultScene({ width: 100, height: 100 }).background;
const annotation = () => ({ version: 1, type: 'arrow', box: [0, 0, 10, -10] });
const scene = () => defaultScene({ width: 100, height: 80 });

function invalidIssues(result: MigrateResult<unknown>): string[] {
  if (result.ok || result.error.kind !== 'invalid') throw new Error('expected an invalid result');
  return result.error.issues;
}

describe('defaultScene', () => {
  it.each([
    [1, 1],
    [1920, 1080],
    [16384, 16384],
  ])('is valid for %i x %i', (width, height) => {
    const s = defaultScene({ width, height });
    expect(migrateScene(s)).toEqual({ ok: true, value: s });
  });
});

describe.each([
  ['scene', migrateScene, scene],
  ['background', migrateBackground, background],
  ['annotation', migrateAnnotation, annotation],
] as const)('migrate %s', (_name, migrate, valid) => {
  it('accepts a valid current document unchanged', () => {
    expect(migrate(valid())).toEqual({ ok: true, value: valid() });
  });

  it.each([
    ['not an object', 'text'],
    ['an array', []],
    ['no version', { ...valid(), version: undefined }],
    ['version 0', { ...valid(), version: 0 }],
    ['version as a string', { ...valid(), version: '1' }],
    ['a fractional version', { ...valid(), version: 1.5 }],
  ])('rejects %s', (_label, input) => {
    expect(migrate(input)).toMatchObject({ ok: false, error: { kind: 'invalid' } });
  });

  it('reports a newer version as too-new', () => {
    const newer = (valid() as { version: number }).version + 1;
    expect(migrate({ ...valid(), version: newer })).toEqual({
      ok: false,
      error: { kind: 'too-new', version: newer, supported: newer - 1 },
    });
  });

  it('rejects unknown keys', () => {
    const result = migrate({ ...valid(), extra: true });
    expect(invalidIssues(result).join('\n')).toContain('extra');
  });
});

describe('field ranges', () => {
  it('names the field of an out-of-range scene number', () => {
    const s = scene();
    s.frame.padding = -1;
    expect(invalidIssues(migrateScene(s))).toEqual([expect.stringContaining('frame.padding')]);
  });

  it('rejects a bad colour', () => {
    const s = scene();
    s.frame.insetColor = 'red';
    expect(invalidIssues(migrateScene(s)).join('\n')).toContain('frame.insetColor');
  });

  it('rejects opacity above 1', () => {
    const b = background();
    b.layers = [{ type: 'solid', color: '#ffffff', opacity: 2 }];
    expect(invalidIssues(migrateBackground(b)).join('\n')).toContain('layers.0.opacity');
  });

  it('rejects more than 16 layers', () => {
    const b = background();
    b.layers = Array.from({ length: 17 }, () => ({ type: 'solid' as const, color: '#ffffff' }));
    expect(invalidIssues(migrateBackground(b)).join('\n')).toContain('layers');
  });

  it('rejects a viewBox smaller than 1 unit', () => {
    const b = background();
    b.viewBox = [0, 0, 0.001, 0.001];
    expect(invalidIssues(migrateBackground(b)).join('\n')).toContain('viewBox');
  });

  it('rejects a blur radius above 100', () => {
    const b = background();
    b.layers = [{ type: 'blur', radius: 101 }];
    expect(invalidIssues(migrateBackground(b)).join('\n')).toContain('layers.0.radius');
  });

  it('rejects a frame that exports beyond 16384 pixels by padding', () => {
    const s = scene();
    s.frame.padding = 8192;
    expect(invalidIssues(migrateScene(s))).toEqual([expect.stringMatching(/^output:/)]);
  });

  it('rejects a frame that exports beyond 16384 pixels by aspect ratio', () => {
    const s = scene();
    s.output.aspectRatio = [100, 0.01];
    expect(invalidIssues(migrateScene(s))).toEqual([expect.stringMatching(/^output:/)]);
  });

  it('rejects a layer type it does not know', () => {
    const b: unknown = { ...background(), layers: [{ type: 'sparkle' }] };
    expect(invalidIssues(migrateBackground(b)).join('\n')).toContain('layers.0');
  });
});

describe('scene mask', () => {
  const withMask = (mask: unknown) => {
    const s = scene();
    return { ...s, screenshot: { ...s.screenshot, mask } };
  };

  it.each([
    ['without a mask', null],
    ['with a v1 background-image mask', { ref: 'user:photo' }],
  ])('upgrades a v1 scene %s to v2 with no mask', (_label, mask) => {
    const result = migrateScene({ ...withMask(mask), version: 1 });
    expect(result).toEqual({ ok: true, value: scene() });
  });

  it('parses a cut-out mask', () => {
    const doc = withMask({ ref: 'mask:abc-1' });
    expect(migrateScene(doc)).toEqual({ ok: true, value: doc });
  });

  it.each(['user:x', 'builtin:x', 'mask:', 'mask:../x', 'mask:a b'])('rejects the mask ref %s', (ref) => {
    expect(invalidIssues(migrateScene(withMask({ ref }))).join('\n')).toContain('screenshot.mask.ref');
  });

  it('reports a v3 scene as too-new', () => {
    expect(migrateScene({ ...scene(), version: 3 })).toEqual({
      ok: false,
      error: { kind: 'too-new', version: 3, supported: 2 },
    });
  });
});

describe('annotation style', () => {
  const styled = (style: object) => ({ ...annotation(), style });

  it('accepts every style field', () => {
    const style = { color: '#112233', strokeWidth: 3, fontSize: 20, fill: '#11223344', radius: 8, strength: 16 };
    expect(migrateAnnotation(styled(style))).toEqual({ ok: true, value: styled(style) });
  });

  it.each([
    ['strength below 1', { strength: 0 }],
    ['strength above 256', { strength: 257 }],
    ['negative radius', { radius: -1 }],
    ['radius above 4096', { radius: 5000 }],
    ['a fill that is not hex', { fill: 'red' }],
  ])('rejects %s', (_label, style) => {
    expect(migrateAnnotation(styled(style))).toMatchObject({ ok: false, error: { kind: 'invalid' } });
  });
});

describe('nested documents in a scene', () => {
  it('reports a too-new background as a too-new scene', () => {
    const result = migrateScene({ ...scene(), background: { ...background(), version: 3 } });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'too-new', version: 3, supported: BACKGROUND_VERSION },
    });
  });

  it('reports a too-new annotation as a too-new scene', () => {
    const result = migrateScene({ ...scene(), annotations: [{ ...annotation(), version: 3 }] });
    expect(result).toMatchObject({ ok: false, error: { kind: 'too-new', version: 3 } });
  });

  it('prefixes issues of an invalid annotation with its path', () => {
    const bad = { ...annotation(), box: [0, 0, 1] };
    const issues = invalidIssues(migrateScene({ ...scene(), annotations: [bad] }));
    expect(issues[0]).toMatch(/^annotations\.0\.box/);
  });

  it('prefixes issues of an invalid background with its path', () => {
    const bad = { ...background(), layers: [] };
    const issues = invalidIssues(migrateScene({ ...scene(), background: bad }));
    expect(issues[0]).toMatch(/^background\.layers/);
  });
});

describe('background version 2', () => {
  const v1 = () => ({ ...background(), version: 1 });
  const code = () => ({ type: 'code' as const, source: 'export default {}', durationMs: 4000 });
  const withLayers = (layers: unknown[]) => ({ ...background(), layers });

  it('upgrades a version 1 background and changes nothing else', () => {
    expect(migrateBackground(v1())).toEqual({ ok: true, value: background() });
  });

  it('upgrades a version 1 background inside a scene', () => {
    expect(migrateScene({ ...scene(), background: v1() })).toEqual({ ok: true, value: scene() });
  });

  it('reports version 3 as too-new, also through a scene', () => {
    const too = { ...background(), version: 3 };
    const error = { kind: 'too-new', version: 3, supported: 2 };
    expect(migrateBackground(too)).toEqual({ ok: false, error });
    expect(migrateScene({ ...scene(), background: too })).toEqual({ ok: false, error });
  });

  it('accepts a code layer, with and without threeD', () => {
    for (const layer of [code(), { ...code(), threeD: true }]) {
      const doc = withLayers([{ type: 'solid', color: '#000000' }, layer]);
      expect(migrateBackground(doc)).toEqual({ ok: true, value: doc });
    }
  });

  it.each([
    ['a source over 65536 characters', { source: 'x'.repeat(65537) }],
    ['an empty source', { source: '' }],
    ['a duration of 999 ms', { durationMs: 999 }],
    ['a duration of 20001 ms', { durationMs: 20001 }],
    ['a fractional duration', { durationMs: 1500.5 }],
  ])('rejects a code layer with %s', (_label, patch) => {
    const issues = invalidIssues(migrateBackground(withLayers([{ ...code(), ...patch }])));
    expect(issues.join('\n')).toContain('layers.0');
  });

  it('rejects two code layers', () => {
    const issues = invalidIssues(migrateBackground(withLayers([code(), code()])));
    expect(issues).toEqual([expect.stringMatching(/^layers: at most one code layer/)]);
  });
});

describe('JSON Schema', () => {
  it('generates for every document', () => {
    expect(() => sceneJsonSchema()).not.toThrow();
    expect(() => annotationJsonSchema()).not.toThrow();
    expect(() => backgroundJsonSchema()).not.toThrow();
  });

  it('lists every layer type in the background schema', () => {
    const text = JSON.stringify(backgroundJsonSchema());
    for (const type of ['solid', 'linear', 'radial', 'conic', 'mesh', 'noise', 'shape', 'image', 'blur', 'code']) {
      expect(text).toContain(`"const":"${type}"`);
    }
    const schema = backgroundJsonSchema() as {
      properties: { layers: { items: { oneOf?: unknown[]; anyOf?: unknown[] } } };
    };
    const items = schema.properties.layers.items;
    expect((items.oneOf ?? items.anyOf)?.length).toBe(10);
  });
});
