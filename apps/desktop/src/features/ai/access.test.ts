import { describe, expect, it } from 'vitest';

import type { Settings } from '../../lib/bindings.ts';
import { aiAccess } from './access.ts';

function settings(ai: Partial<Settings['ai']>): Settings {
  return {
    version: 7,
    captureShortcut: 'Alt+Shift+S',
    theme: 'system',
    autostartAsked: true,
    saveHistory: true,
    excludeFromClipboardHistory: false,
    saveFolder: null,
    ai: {
      lastProvider: null,
      lastModel: null,
      favoriteModels: [],
      allowImages: false,
      effort: 'low',
      onboardingAnswered: false,
      ...ai,
    },
  };
}

describe('aiAccess', () => {
  it('waits for the settings to load', () => {
    expect(aiAccess(undefined).state).toBe('loading');
  });

  it('carries the last choice, the favorites and the image choice', () => {
    const favorites = [{ provider: 'codex' as const, model: 'gpt-6.1-sol' }];
    expect(
      aiAccess(settings({ lastProvider: 'claude', lastModel: 'opus', favoriteModels: favorites, allowImages: true })),
    ).toEqual({
      state: 'ready',
      allowImages: true,
      effort: 'low',
      lastProvider: 'claude',
      lastModel: 'opus',
      favorites,
    });
  });

  it('is ready with no provider chosen yet', () => {
    const access = aiAccess(settings({}));
    expect(access.state).toBe('ready');
    expect(access.lastProvider).toBeNull();
  });

  it('carries the effort the user chose', () => {
    expect(aiAccess(settings({ effort: 'high' })).effort).toBe('high');
  });
});
