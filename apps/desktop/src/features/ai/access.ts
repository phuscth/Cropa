import { useEffect, useState } from 'react';

import { commands, type AiProvider, type Settings } from '../../lib/bindings.ts';

/** Whether AI features may run: no provider chosen yet means locked. */
export interface AiAccess {
  state: 'loading' | 'locked' | 'ready';
  provider: AiProvider | null;
  allowImages: boolean;
}

export function aiAccess(settings: Settings | undefined): AiAccess {
  if (!settings) return { state: 'loading', provider: null, allowImages: false };
  const provider = settings.ai.provider ?? null;
  const allowImages = settings.ai.allowImages ?? false;
  return { state: provider ? 'ready' : 'locked', provider, allowImages };
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
