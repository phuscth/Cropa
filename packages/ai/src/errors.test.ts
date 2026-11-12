import { describe, expect, it } from 'vitest';

import { isAgentErrorKind } from './errors.ts';

describe('isAgentErrorKind', () => {
  it('accepts every known kind', () => {
    expect(isAgentErrorKind('Timeout')).toBe(true);
    expect(isAgentErrorKind('NotLoggedIn')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isAgentErrorKind('timeout')).toBe(false);
    expect(isAgentErrorKind(42)).toBe(false);
    expect(isAgentErrorKind(undefined)).toBe(false);
  });
});
