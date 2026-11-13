import { useEffect, useState } from 'react';

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
 * The AI access of this window. Settings can change in another window, so they
 * are read again whenever this window gains the focus. The window needs
 * `allow-get-settings`.
 */
export function useAiAccess(): AiAccess {
  const [settings, setSettings] = useState<Settings>();
  useEffect(() => {
    const load = () => {
      commands.getSettings().then(setSettings).catch(() => undefined);
    };
    load();
    window.addEventListener('focus', load);
    return () => { window.removeEventListener('focus', load); };
  }, []);
  return aiAccess(settings);
}
