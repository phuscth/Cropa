import { useCallback, useEffect, useRef, useState } from 'react';

import type { AiDetection, AiProvider } from '../../lib/bindings.ts';
import { detectProviders } from './detect.ts';
import { listModels, type ModelEntry, type ModelList } from './models.ts';
import { cliStatus, listProviders, type CliStatus, type ListedProvider } from './providers.ts';

/** The least time between two detections that the window gaining focus starts. */
const FOCUS_THROTTLE_MS = 30_000;

export interface ProviderState {
  provider: AiProvider;
  status: CliStatus;
  detection: AiDetection;
  /** `loading` until the list came back, or while the provider is not ready. */
  models: ModelEntry[] | 'loading';
  /** The list could not be read, so only the CLI's default is offered. */
  listFailed: boolean;
}

/**
 * Which providers are offered and where each stands, detected when the window mounts, when it
 * regains the focus (at most once per 30 s) and on `recheck`. `undefined` until the first
 * detection is done.
 */
export function useDetection(): {
  listed: ListedProvider[] | undefined;
  /** A detection after the first is running; the last result stays in `listed` meanwhile. */
  rechecking: boolean;
  recheck: () => void;
} {
  const [listed, setListed] = useState<ListedProvider[]>();
  const [rechecking, setRechecking] = useState(false);
  const lastRun = useRef(0);

  const detect = useCallback(() => {
    lastRun.current = Date.now();
    detectProviders()
      .then((found) => { setListed(listProviders(found, import.meta.env.DEV)); })
      .catch(() => { setListed((before) => before ?? []); })
      .finally(() => { setRechecking(false); });
  }, []);

  useEffect(() => {
    detect();
    const onFocus = () => {
      if (Date.now() - lastRun.current >= FOCUS_THROTTLE_MS) detect();
    };
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); };
  }, [detect]);

  const recheck = useCallback(() => {
    setRechecking(true);
    detect();
  }, [detect]);

  return { listed, rechecking, recheck };
}

/**
 * The providers with their models. Models are listed for each provider that is ready, once, and
 * again after a failure whenever detection runs.
 */
export function useAiProviders(): {
  providers: ProviderState[];
  /** The first detection is still running. */
  detecting: boolean;
  rechecking: boolean;
  recheck: () => void;
} {
  const { listed, rechecking, recheck } = useDetection();
  const [lists, setLists] = useState<Partial<Record<AiProvider, ModelList>>>({});

  useEffect(() => {
    if (!listed) return;
    let current = true;
    for (const { provider, detection } of listed) {
      if (cliStatus(detection) !== 'ready') continue;
      if (lists[provider] && !lists[provider].failed) continue;
      void listModels(provider).then((list) => {
        if (current) setLists((before) => ({ ...before, [provider]: list }));
      });
    }
    return () => { current = false; };
    // `lists` is read only to skip what is already loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listed]);

  const providers = (listed ?? []).map(({ provider, detection }): ProviderState => {
    const list = lists[provider];
    return {
      provider,
      status: cliStatus(detection),
      detection,
      models: list ? list.models : 'loading',
      listFailed: list?.failed ?? false,
    };
  });
  return { providers, detecting: listed === undefined, rechecking, recheck };
}
