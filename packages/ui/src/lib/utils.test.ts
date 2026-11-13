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

describe('cn with the type steps', () => {
  it('keeps a type step next to a text colour, in either order', () => {
    expect(cn('text-control', 'text-primary-foreground')).toBe('text-control text-primary-foreground');
    expect(cn('text-muted-foreground', 'text-control-sm')).toBe('text-muted-foreground text-control-sm');
  });

  it('lets a later type step replace an earlier one', () => {
    expect(cn('text-control', 'text-control-sm')).toBe('text-control-sm');
  });
});
