import { describe, expect, it } from 'vitest';

import { cn } from './utils.ts';

describe('cn', () => {
  it('drops falsy values', () => {
    expect(cn('a', false, undefined, 'b')).toBe('a b');
  });

  it('lets later Tailwind utilities override earlier ones', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
  });
});
