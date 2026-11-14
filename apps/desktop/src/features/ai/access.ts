import { useEffect, useState } from 'react';

import { useViewActive } from '../shell/view-active.ts';
import {
  commands,
  type AiEffort,
  type AiProvider,
  type FavoriteModel,
  type Settings,
} from '../../lib/bindings.ts';

/** What the settings say about AI. Whether a provider can run comes from detection, not from here. */
export interface AiAccess {
  state: 'loading' | 'ready';
  allowImages: boolean;
  /** The effort the user last chose for AI tasks; low until they choose. */
  effort: AiEffort;
  /** The provider and model of the last message the user sent; null until they chose one. */
  lastProvider: AiProvider | null;
  lastModel: string | null;
  /** The models starred in the picker, in the order they were starred. */
  favorites: FavoriteModel[];
}

export function aiAccess(settings: Settings | undefined): AiAccess {
  if (!settings) {
    return {
      state: 'loading',
      allowImages: false,
      effort: 'low',
      lastProvider: null,
      lastModel: null,
      favorites: [],
    };
  }
  const { ai } = settings;
  return {
    state: 'ready',
    allowImages: ai.allowImages ?? false,
    effort: ai.effort ?? 'low',
    lastProvider: ai.lastProvider ?? null,
    lastModel: ai.lastModel ?? null,
    favorites: ai.favoriteModels ?? [],
  };
}

/**
 * The AI settings of this window, read again whenever the window gains the focus and whenever
 * this view comes to the front. The window needs `allow-get-settings`.
 */
export function useAiAccess(): AiAccess {
  const [settings, setSettings] = useState<Settings>();
  const active = useViewActive();
  useEffect(() => {
    const load = () => {
      commands.getSettings().then(setSettings).catch(() => undefined);
    };
    if (active) load();
    window.addEventListener('focus', load);
    return () => { window.removeEventListener('focus', load); };
  }, [active]);
  return aiAccess(settings);
}
