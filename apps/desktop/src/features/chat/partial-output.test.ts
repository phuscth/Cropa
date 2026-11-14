import { describe, expect, it } from 'vitest';

import { partialSource } from './partial-output.ts';

describe('partialSource', () => {
  const answer = { source: 'const a = "x";\nfunction back(ctx) {\t}é😀', durationMs: 4000, threeD: false };
  const json = JSON.stringify(answer);

  it('decodes the source of a complete answer and stops at the closing quote', () => {
    expect(partialSource(json)).toBe(answer.source);
  });

  it('gives a prefix of the source for every cut of the text, never a broken escape', () => {
    for (let end = 0; end <= json.length; end += 1) {
      // The chunks arrive as whole characters, so a cut never splits a surrogate pair.
      if (/[\ud800-\udbff]/.test(json.charAt(end - 1))) continue;
      const text = partialSource(json.slice(0, end));
      expect(answer.source.startsWith(text)).toBe(true);
      expect(text).not.toMatch(/[\ud800-\udbff]$/);
    }
  });

  it('is empty until the source field has begun, wherever the field sits', () => {
    expect(partialSource('')).toBe('');
    expect(partialSource('{"durationMs":4000,"sou')).toBe('');
    expect(partialSource('{"durationMs":4000,"source":"ab')).toBe('ab');
    expect(partialSource('{ "source" : "a\\n')).toBe('a\n');
  });

  it('waits for the rest of a cut \\u escape and of a surrogate pair', () => {
    expect(partialSource('{"source":"a\\u00')).toBe('a');
    expect(partialSource('{"source":"a\\u00e9')).toBe('aé');
    expect(partialSource('{"source":"a\\ud83d')).toBe('a');
    expect(partialSource('{"source":"a\\ud83d\\ude0')).toBe('a');
    expect(partialSource('{"source":"a\\ud83d\\ude00b')).toBe('a😀b');
    expect(partialSource('{"source":"a\\')).toBe('a');
  });

  it('shows the newest answer when a second one follows the first in the stream', () => {
    const two = JSON.stringify({ source: 'first', durationMs: 1 }) + JSON.stringify({ source: 'second' });
    expect(partialSource(two)).toBe('second');
    expect(partialSource(two.slice(0, two.indexOf('second') + 3))).toBe('sec');
    expect(partialSource(`${JSON.stringify({ source: 'first' })}{"sou`)).toBe('first');
  });

  it('does not take a source key that sits inside another string', () => {
    const text = JSON.stringify({ note: '"source": "fake"', source: 'real' });
    expect(partialSource(text)).toBe('real');
  });
});
