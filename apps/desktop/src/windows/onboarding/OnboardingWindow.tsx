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
    <main className="mx-auto flex max-w-[640px] flex-col gap-6 px-8 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-title">{t('onboarding.title')}</h1>
        <p className="text-base text-muted-foreground">{t('onboarding.welcome')}</p>
      </header>

      {error && <ErrorNotice error={error} onDismiss={() => { setError(undefined); }} />}

      {step === 'autostart' && (
        <fieldset className="flex flex-col gap-3 rounded-xl border bg-card p-5">
          <legend className="float-left mb-3 w-full text-heading">
            {t('onboarding.autostart.question')}
          </legend>
          {([true, false] as const).map((value) => (
            <label
              key={String(value)}
              className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-sm transition-colors duration-150 ease-enter hover:border-foreground/30 has-[:checked]:border-primary has-[:checked]:bg-selected/40 has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-primary/16"
            >
              <input
                type="radio"
                name="autostart"
                className="size-4 shrink-0"
                checked={startWithWindows === value}
                disabled={busy || answeredWithError}
                onChange={() => { setStartWithWindows(value); }}
              />
              {value ? t('onboarding.autostart.yes') : t('onboarding.autostart.no')}
            </label>
          ))}
          <div className="flex justify-end pt-2">
            <Button disabled={busy} onClick={() => { void answer(); }}>
              {t('onboarding.autostart.continue')}
            </Button>
          </div>
        </fieldset>
      )}

      {step === 'ai' && (
        <section className="flex flex-col gap-3">
          <h2 className="text-heading">{t('onboarding.ai.heading')}</h2>
          <AiOnboarding mode="first" onSaved={finish} />
        </section>
      )}
    </main>
  );
}
