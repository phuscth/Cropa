import { describe, expect, it } from 'vitest';

import en from './en.json';
import vi from './vi.json';
import { pickLanguage } from './index.ts';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

function placeholders(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      out[path] = [...v.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? '').sort();
    } else if (typeof v === 'object' && v !== null) {
      for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k);
    }
  };
  walk(value, '');
  return out;
}

describe('translations', () => {
  it('en and vi have exactly the same keys', () => {
    expect(keys(vi).sort()).toEqual(keys(en).sort());
  });

  it('en and vi use the same placeholders in every string', () => {
    expect(placeholders(vi)).toEqual(placeholders(en));
  });
});

describe('pickLanguage', () => {
  it('matches the primary subtag', () => {
    expect(pickLanguage(['vi-VN'])).toBe('vi');
    expect(pickLanguage(['en-GB'])).toBe('en');
  });

  it('takes the first supported language in order', () => {
    expect(pickLanguage(['fr-FR', 'vi', 'en'])).toBe('vi');
  });

  it('falls back to English', () => {
    expect(pickLanguage(['ja-JP'])).toBe('en');
    expect(pickLanguage([])).toBe('en');
  });
});
