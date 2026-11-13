import { describe, expect, it } from 'vitest';

import { AgentError, isAgentErrorKind, toAgentErrorKind } from './errors.ts';

describe('isAgentErrorKind', () => {
  it('accepts every known kind', () => {
    expect(isAgentErrorKind('Timeout')).toBe(true);
    expect(isAgentErrorKind('NotLoggedIn')).toBe(true);
    expect(isAgentErrorKind('Unsupported')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isAgentErrorKind('timeout')).toBe(false);
    expect(isAgentErrorKind(42)).toBe(false);
    expect(isAgentErrorKind(undefined)).toBe(false);
  });
});

describe('toAgentErrorKind', () => {
  it('uses the kind of an AgentError', () => {
    expect(toAgentErrorKind(new AgentError('UsageLimit'))).toBe('UsageLimit');
  });

  it('lets an aborted signal win over the error kind', () => {
    const controller = new AbortController();
    controller.abort();
    expect(toAgentErrorKind(new AgentError('Protocol'), controller.signal)).toBe('Cancelled');
  });

  it('maps any other error to Cancelled once the signal is aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(toAgentErrorKind(new Error('boom'), controller.signal)).toBe('Cancelled');
  });

  it('accepts a plain object with a known kind', () => {
    expect(toAgentErrorKind({ kind: 'NotInstalled' })).toBe('NotInstalled');
  });

  it('maps anything else to Protocol', () => {
    expect(toAgentErrorKind({ kind: 'Nope' })).toBe('Protocol');
    expect(toAgentErrorKind(new Error('boom'))).toBe('Protocol');
    expect(toAgentErrorKind('Timeout')).toBe('Protocol');
    expect(toAgentErrorKind(undefined)).toBe('Protocol');
  });
});
