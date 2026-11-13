import { describe, expect, it } from 'vitest';

import { paletteNameTask } from './palette-name.ts';

const input = { colors: ['#112233', '#445566'] };

describe('paletteNameTask', () => {
  it('describes name and mood as required strings', () => {
    const schema = paletteNameTask.jsonSchema as {
      required: string[];
      properties: Record<string, { type: string }>;
    };
    expect([...schema.required].sort()).toEqual(['mood', 'name']);
    expect(schema.properties['name']?.type).toBe('string');
    expect(schema.properties['mood']?.type).toBe('string');
  });

  it('clamps long fields and collapses whitespace', () => {
    const out = paletteNameTask.postprocess(
      { name: `  Misty \n  ${'x'.repeat(60)}`, mood: 'a'.repeat(40) },
      { input },
    );
    expect(out.name.startsWith('Misty x')).toBe(true);
    expect(Array.from(out.name).length).toBeLessThanOrEqual(32);
    expect(out.mood).toBe('a'.repeat(24));
  });

  it('never splits a surrogate pair at the cut', () => {
    const name = `${'a'.repeat(31)}\u{1F600}tail`;
    const out = paletteNameTask.postprocess({ name, mood: 'calm' }, { input });
    expect(out.name).toBe(`${'a'.repeat(31)}\u{1F600}`);
  });

  it('takes a blank field from the fallback', () => {
    const out = paletteNameTask.postprocess({ name: '  \n ', mood: 'bright' }, { input });
    expect(out.name).toBe(paletteNameTask.fallback(input).name);
    expect(out.mood).toBe('bright');
  });

  it('has a deterministic fallback that follows the colours', () => {
    expect(paletteNameTask.fallback(input)).toEqual(paletteNameTask.fallback({ ...input }));
    expect(paletteNameTask.fallback({ colors: ['#0000ff', '#1010f0'] }).name).toContain('Blue');
    expect(paletteNameTask.fallback({ colors: ['#f0f0ff'] }).name).toMatch(/^Pale /);
  });

  it('uses a fixed name for an empty or invalid list', () => {
    const empty = paletteNameTask.fallback({ colors: [] });
    expect(paletteNameTask.fallback({ colors: ['nope', '#12'] })).toEqual(empty);
    expect(empty.name).not.toBe('');
  });

  it('lists the normalised colours in the prompt and skips invalid ones', () => {
    const prompt = paletteNameTask.buildPrompt({ colors: ['#ABC', '#112233', 'red'] });
    expect(prompt.user).toContain('#aabbcc, #112233');
    expect(prompt.user).not.toContain('red');
  });
});
