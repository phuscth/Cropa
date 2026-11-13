import { Button } from '@cropa/ui';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AiOnboarding } from '../../features/ai/AiOnboarding.tsx';
import { commands } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';

type Step = 'autostart' | 'ai';

/** First launch: start with Windows (when not asked yet), then AI setup. */
export function OnboardingWindow() {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>();
  const [startWithWindows, setStartWithWindows] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserError>();
  // The answer was given, but applying it failed: the next click only moves on.
  const [answeredWithError, setAnsweredWithError] = useState(false);

  useEffect(() => {
    commands
      .getSettings()
      .then((settings) => { setStep(settings.autostartAsked ? 'ai' : 'autostart'); })
      .catch((cause: unknown) => {
        // Start at the first question: Rust skips whatever was already answered.
        setStep('autostart');
        setError(describeUnexpected(t, cause));
      });
  }, [t]);

  const finish = () => {
    getCurrentWindow().close().catch((cause: unknown) => { setError(describeUnexpected(t, cause)); });
  };

  const answer = async () => {
    if (answeredWithError) {
      setStep('ai');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await commands.answerAutostartQuestion(startWithWindows);
      if (result.status === 'error') {
        // The question counts as answered even so; show why and let the user continue.
        setError(describeCommandError(t, result.error));
        setAnsweredWithError(true);
      } else {
        setStep('ai');
      }
    } catch (cause) {
      setError(describeUnexpected(t, cause));
      setAnsweredWithError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-5 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">{t('onboarding.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('onboarding.welcome')}</p>
      </header>

      {error && <ErrorNotice error={error} onDismiss={() => { setError(undefined); }} />}

      {step === 'autostart' && (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">{t('onboarding.autostart.question')}</legend>
          {([true, false] as const).map((value) => (
            <label key={String(value)} className="flex items-center gap-3 text-sm">
              <input
                type="radio"
                name="autostart"
                className="size-4"
                checked={startWithWindows === value}
                disabled={busy || answeredWithError}
                onChange={() => { setStartWithWindows(value); }}
              />
              {value ? t('onboarding.autostart.yes') : t('onboarding.autostart.no')}
            </label>
          ))}
          <div>
            <Button size="sm" disabled={busy} onClick={() => { void answer(); }}>
              {t('onboarding.autostart.continue')}
            </Button>
          </div>
        </fieldset>
      )}

      {step === 'ai' && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">{t('onboarding.ai.heading')}</h2>
          <AiOnboarding mode="first" onSaved={finish} />
        </section>
      )}
    </main>
  );
}
