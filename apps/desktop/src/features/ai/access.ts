import { useEffect, useState } from 'react';

import { useViewActive } from '../shell/view-active.ts';
import { commands, type AiEffort, type AiProvider, type Settings } from '../../lib/bindings.ts';

/** Whether AI features may run: no provider chosen yet means locked. */
export interface AiAccess {
  state: 'loading' | 'locked' | 'ready';
  provider: AiProvider | null;
  allowImages: boolean;
  /** The effort the user last chose for AI tasks; low until they choose. */
  effort: AiEffort;
}

export function aiAccess(settings: Settings | undefined): AiAccess {
  if (!settings) return { state: 'loading', provider: null, allowImages: false, effort: 'low' };
  const provider = settings.ai.provider ?? null;
  const allowImages = settings.ai.allowImages ?? false;
  return { state: provider ? 'ready' : 'locked', provider, allowImages, effort: settings.ai.effort ?? 'low' };
}

/**
 * The AI access of this window. The provider is chosen in the Settings view, so
 * the settings are read again whenever the window gains the focus and whenever
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
