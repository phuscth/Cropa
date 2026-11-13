import { describe, expect, it } from 'vitest';

import type { AiDetection } from '../../lib/bindings.ts';
import { capabilitiesOf, cliStatus, listProviders } from './providers.ts';

function detection(overrides: Partial<AiDetection> = {}): AiDetection {
  return {
    provider: 'codex',
    available: true,
    installed: true,
    version: null,
    loggedIn: true,
    imageIn: false,
    imageOut: false,
    ...overrides,
  };
}

describe('cliStatus', () => {
  it('is unavailable while Cropa has no adapter, whatever else is known', () => {
    expect(cliStatus(detection({ available: false, installed: null, loggedIn: null }))).toBe(
      'unavailable',
    );
  });

  it('asks to install before it asks to log in', () => {
    expect(cliStatus(detection({ installed: false, loggedIn: false }))).toBe('notInstalled');
    expect(cliStatus(detection({ loggedIn: false }))).toBe('notLoggedIn');
  });

  it('is ready when logged in, and when the login is unknown', () => {
    expect(cliStatus(detection())).toBe('ready');
    expect(cliStatus(detection({ loggedIn: null }))).toBe('ready');
  });
});

describe('capabilitiesOf', () => {
  it('lists what the provider reports', () => {
    expect(capabilitiesOf(detection())).toEqual([]);
    expect(capabilitiesOf(detection({ imageIn: true, imageOut: true }))).toEqual([
      'image-in',
      'image-out',
    ]);
  });
});

describe('listProviders', () => {
  const found = [
    detection({ provider: 'codex' }),
    detection({ provider: 'claude' }),
    detection({ provider: 'mock' }),
    detection({ provider: 'other' }),
  ];

  it('offers the mock provider only in development builds', () => {
    expect(listProviders(found, false).map((p) => p.provider)).toEqual(['codex', 'claude']);
    expect(listProviders(found, true).map((p) => p.provider)).toEqual(['codex', 'claude', 'mock']);
  });

  it('skips a provider the backend did not report', () => {
    expect(listProviders([detection({ provider: 'claude' })], true).map((p) => p.provider)).toEqual([
      'claude',
    ]);
  });
});
