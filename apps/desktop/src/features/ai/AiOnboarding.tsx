import { Button } from '@cropa/ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  commands,
  type AiCli,
  type AiDetection,
  type AiProvider,
  type CommandError,
  type Settings,
} from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';
import { detectProviders } from './detect.ts';
import { cliStatus, listProviders, providerName, type ListedProvider } from './providers.ts';

interface Props {
  /** `first`: the welcome window's question, ended by choosing or "Later". `change`: opened from the AI section. */
  mode: 'first' | 'change';
  /** The user chose a provider, or dismissed the first-launch question. */
  onSaved: (settings: Settings) => void;
  /** The user closed a `change` panel without choosing. */
  onCancel?: () => void;
}

type Result<T> =
  | { status: 'ok'; data: T }
  | { status: 'error'; error: CommandError };

function isCli(provider: AiProvider): provider is AiCli {
  return provider === 'codex' || provider === 'claude';
}

/** Lists the AI providers with what each needs, and lets the user pick one. */
export function AiOnboarding({ mode, onSaved, onCancel }: Props) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ListedProvider[]>();
  const [error, setError] = useState<UserError>();
  const [busy, setBusy] = useState(false);

  const detect = useCallback(() => {
    detectProviders()
      .then((found) => { setProviders(listProviders(found, import.meta.env.DEV)); })
      .catch((cause: unknown) => {
        setProviders([]);
        setError(describeUnexpected(t, cause));
      });
  }, [t]);

  useEffect(detect, [detect]);

  const recheck = () => {
    setProviders(undefined);
    detect();
  };

  const run = async <T,>(call: () => Promise<Result<T>>): Promise<T | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await call();
      if (result.status === 'error') {
        setError(describeCommandError(t, result.error));
        return undefined;
      }
      return result.data;
    } catch (cause) {
      setError(describeUnexpected(t, cause));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const choose = async (provider: AiProvider) => {
    const settings = await run(() => commands.setAiProvider(provider));
    if (settings) onSaved(settings);
  };

  const later = async () => {
    const settings = await run(() => commands.dismissAiOnboarding());
    if (settings) onSaved(settings);
  };

  const statusText = (detection: AiDetection) => t(`ai.status.${cliStatus(detection)}`);

  return (
    <section
      className={
        mode === 'first'
          ? 'flex flex-col gap-4 rounded-xl bg-card p-5 shadow-soft'
          : 'flex flex-col gap-4'
      }
      aria-labelledby="ai-onboarding"
    >
      <h2 id="ai-onboarding" className="text-sm font-medium">
        {t('ai.onboarding.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('ai.onboarding.intro')}</p>

      {error && <ErrorNotice error={error} onDismiss={() => { setError(undefined); }} />}

      {providers === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('ai.onboarding.checking')}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {providers.map(({ provider, detection }) => {
            const status = cliStatus(detection);
            return (
              <li key={provider} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="flex flex-col">
                  <span className="font-medium">{providerName(t, provider)}</span>
                  <span className="text-sm text-muted-foreground">{statusText(detection)}</span>
                </div>
                <div className="flex gap-2">
                  {status === 'ready' && (
                    <Button size="sm" disabled={busy} onClick={() => { void choose(provider); }}>
                      {t('ai.onboarding.use')}
                    </Button>
                  )}
                  {status === 'notInstalled' && isCli(provider) && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => { void run(() => commands.openAiInstallGuide(provider)); }}
                    >
                      {t('ai.onboarding.installGuide')}
                    </Button>
                  )}
                  {status === 'notLoggedIn' && isCli(provider) && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => { void run(() => commands.openLoginTerminal(provider)); }}
                    >
                      {t('ai.onboarding.login')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={recheck}>
          {t('ai.onboarding.recheck')}
        </Button>
        {mode === 'first' ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void later(); }}>
            {t('ai.onboarding.later')}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            {t('ai.onboarding.cancel')}
          </Button>
        )}
      </div>
    </section>
  );
}
