import { describe, expect, it } from 'vitest';

import type { AiDetection } from '../../../lib/bindings.ts';
import { dataUrlBase64, dataUrlBytes, removeBackgroundLock } from './rules.ts';

function codex(overrides: Partial<AiDetection> = {}): AiDetection {
  return {
    provider: 'codex',
    available: true,
    installed: true,
    version: '0.167.0',
    versionSupported: true,
    loggedIn: true,
    imageIn: true,
    imageOut: true,
    ...overrides,
  };
}

const open = { hasImage: true, loading: false, codex: codex(), allowImages: true };

describe('removeBackgroundLock', () => {
  it('is open when an image is loaded, Codex can make images and images may be sent', () => {
    expect(removeBackgroundLock(open)).toBeNull();
    expect(removeBackgroundLock({ ...open, codex: codex({ loggedIn: null }) })).toBeNull();
  });

  it('asks for an image before anything else', () => {
    expect(
      removeBackgroundLock({ hasImage: false, loading: true, codex: undefined, allowImages: false }),
    ).toBe('noImage');
  });

  it('waits while detection or the settings are being read', () => {
    expect(removeBackgroundLock({ ...open, loading: true, codex: undefined })).toBe('checking');
  });

  it.each([
    ['not reported', undefined],
    ['no adapter', codex({ available: false, installed: null, loggedIn: null })],
    ['not installed', codex({ installed: false })],
    ['not signed in', codex({ loggedIn: false })],
    ['a version that cannot make images', codex({ imageOut: false })],
    ['no image input', codex({ imageIn: false })],
  ])('needs Codex when it is %s', (_name, detection) => {
    expect(removeBackgroundLock({ ...open, codex: detection })).toBe('needsCodex');
  });

  it('names the missing Codex before the images setting', () => {
    expect(removeBackgroundLock({ ...open, codex: undefined, allowImages: false })).toBe('needsCodex');
    expect(removeBackgroundLock({ ...open, allowImages: false })).toBe('imagesOff');
  });
});

describe('data URLs', () => {
  it('measures the bytes behind the base64, padding included', () => {
    expect(dataUrlBytes('data:image/png;base64,YWJj')).toBe(3);
    expect(dataUrlBytes('data:image/png;base64,YWI=')).toBe(2);
    expect(dataUrlBytes('data:image/png;base64,YQ==')).toBe(1);
  });

  it('keeps only the base64', () => {
    expect(dataUrlBase64('data:image/png;base64,YWJj')).toBe('YWJj');
  });
});
