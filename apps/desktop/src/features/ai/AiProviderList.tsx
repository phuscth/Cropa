import { Button } from '@cropa/ui';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, type AiCli, type AiProvider, type CommandError } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';
import { ProviderLogo } from './ProviderLogo.tsx';
import { cliStatus, providerName, type CliStatus, type ListedProvider } from './providers.ts';

type Result = { status: 'ok'; data: unknown } | { status: 'error'; error: CommandError };

function isCli(provider: AiProvider): provider is AiCli {
  return provider === 'codex' || provider === 'claude';
}

interface Props {
  /** The providers found; undefined while the first detection runs. */
  listed: ListedProvider[] | undefined;
  /** Runs the detection again. */
  recheck: () => void;
  /** A detection is running again; the list shown is the last result. */
  rechecking?: boolean;
  /** More controls for a provider, shown after its install or login button. */
  actions?: (provider: ListedProvider, status: CliStatus) => ReactNode;
  /** More content under a provider's row, such as a test result. */
  below?: (provider: ListedProvider) => ReactNode;
  /** Disables every button, for example while a test runs. */
  disabled?: boolean;
}

/**
 * Every AI provider with where it stands and what to do next: an install guide when it is not
 * installed, a login when it is not logged in. Shared by Settings and the welcome window.
 */
export function AiProviderList({ listed, recheck, rechecking = false, actions, below, disabled = false }: Props) {
  const { t } = useTranslation();
  const [error, setError] = useState<UserError>();
  const [busy, setBusy] = useState(false);

  const run = async (call: () => Promise<Result>) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await call();
      if (result.status === 'error') setError(describeCommandError(t, result.error));
    } catch (cause) {
      setError(describeUnexpected(t, cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error && <ErrorNotice error={error} onDismiss={() => { setError(undefined); }} />}
      {listed === undefined ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('ai.onboarding.checking')}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {listed.map((item) => {
            const { provider, detection } = item;
            const status = cliStatus(detection);
            const version = detection.version ?? null;
            return (
              <li key={provider} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-5 shrink-0 items-center justify-center text-[18px]">
                      <ProviderLogo provider={provider} />
                    </span>
                    <div className="flex min-w-0 flex-col">
                      <span className="text-control-sm">{providerName(t, provider)}</span>
                      <span className="text-[13px] leading-snug text-muted-foreground">
                        {status === 'ready' && version
                          ? t('ai.status.readyVersion', { version })
                          : t(`ai.status.${status}`)}
                      </span>
                      {status === 'ready' && detection.versionSupported === false && (
                        <span className="text-[13px] leading-snug text-muted-foreground">
                          {t('ai.status.versionUntested')}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {status === 'notInstalled' && isCli(provider) && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || disabled}
                        onClick={() => { void run(() => commands.openAiInstallGuide(provider)); }}
                      >
                        {t('ai.onboarding.installGuide')}
                      </Button>
                    )}
                    {status === 'notLoggedIn' && isCli(provider) && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy || disabled}
                        onClick={() => { void run(() => commands.openLoginTerminal(provider)); }}
                      >
                        {t('ai.onboarding.login')}
                      </Button>
                    )}
                    {actions?.(item, status)}
                  </div>
                </div>
                {below?.(item)}
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <Button variant="outline" size="sm" disabled={busy || disabled || rechecking || listed === undefined} onClick={recheck}>
          {t('ai.onboarding.recheck')}
        </Button>
      </div>
    </div>
  );
}
