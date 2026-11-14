import { Button, CheckCircleIcon, ImageIcon } from '@cropa/ui';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorNotice } from '../../../lib/ErrorNotice.tsx';
import { Section } from '../Section.tsx';
import type { RemoveBackgroundController } from './use-remove-background.ts';

/** Whole seconds since `startedAt`, counted up while it is on screen. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <span className="ml-auto tabular-nums">{t('removeBackground.elapsed', { seconds })}</span>;
}

/**
 * The editor panel's "Remove background" section: the button and why it is off, the progress
 * of a run with Cancel, and, once the screenshot is cut out, the way back.
 */
export function RemoveBackgroundSection({ controller }: { controller: RemoveBackgroundController }) {
  const { t } = useTranslation();
  const hintId = useId();
  const { lock, startedAt, masked, error, run, cancel, restore, dismissError } = controller;

  return (
    <Section title={t('removeBackground.title')}>
      {startedAt !== null ? (
        <div role="status" className="flex flex-col gap-2.5 rounded-xl bg-card p-3 shadow-soft">
          <div className="text-control-sm flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-ring motion-reduce:animate-none"
            />
            <span>{t('removeBackground.working')}</span>
            <span className="text-caption flex-1">
              <Elapsed key={startedAt} startedAt={startedAt} />
            </span>
          </div>
          <p className="text-caption">{t('removeBackground.workingHint')}</p>
          <Button variant="secondary" size="sm" className="w-full" onClick={cancel}>
            {t('removeBackground.cancel')}
          </Button>
        </div>
      ) : masked ? (
        <div className="flex flex-col gap-2.5 rounded-xl bg-card p-3 shadow-soft">
          <div className="text-control-sm flex items-center gap-2">
            <CheckCircleIcon aria-hidden="true" className="size-4 shrink-0 text-success" />
            <span>{t('removeBackground.done')}</span>
          </div>
          <p className="text-caption">{t('removeBackground.note')}</p>
          <Button variant="secondary" size="sm" className="w-full" onClick={restore}>
            {t('removeBackground.restore')}
          </Button>
        </div>
      ) : (
        <>
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            disabled={lock !== null}
            aria-describedby={hintId}
            onClick={run}
          >
            <ImageIcon aria-hidden="true" />
            {t('removeBackground.button')}
          </Button>
          <p id={hintId} className="text-caption">
            {lock === null ? t('removeBackground.hint') : t(`removeBackground.lock.${lock}`)}
          </p>
        </>
      )}
      {error && <ErrorNotice error={error} onDismiss={dismissError} />}
    </Section>
  );
}
