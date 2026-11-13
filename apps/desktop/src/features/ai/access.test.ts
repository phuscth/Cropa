import { describe, expect, it } from 'vitest';

import type { Settings } from '../../lib/bindings.ts';
import { aiAccess } from './access.ts';

function settings(ai: Partial<Settings['ai']>): Settings {
  return {
    version: 5,
    captureShortcut: 'Alt+Shift+S',
    theme: 'system',
    autostartAsked: true,
    saveHistory: true,
    excludeFromClipboardHistory: false,
    saveFolder: null,
    ai: { provider: null, allowImages: false, onboardingAnswered: false, ...ai },
  };
}

describe('aiAccess', () => {
  it('waits for the settings to load', () => {
    expect(aiAccess(undefined).state).toBe('loading');
  });

  it('is locked until a provider is chosen', () => {
    expect(aiAccess(settings({ onboardingAnswered: true })).state).toBe('locked');
  });

  it('is ready with the chosen provider and the image choice', () => {
    expect(aiAccess(settings({ provider: 'claude', allowImages: true }))).toEqual({
      state: 'ready',
      provider: 'claude',
      allowImages: true,
    });
  });
});
