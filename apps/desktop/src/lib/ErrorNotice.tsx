import { Button } from '@cropa/ui';
import { useTranslation } from 'react-i18next';

import type { UserError } from './errors.ts';

interface Props {
  error: UserError;
  /** When given, the notice shows a close button. */
  onDismiss?: () => void;
}

/** A soft red notice that slides up and fades in; it says what happened, why and what to do. */
export function ErrorNotice({ error, onDismiss }: Props) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="relative animate-notice-in rounded-xl bg-danger-soft p-4 text-control-sm font-normal"
    >
      <p className={onDismiss ? 'pr-8 font-medium text-destructive' : 'font-medium text-destructive'}>
        {error.what}
      </p>
      <p className="mt-1 text-muted-foreground">{error.why}</p>
      <p className="mt-1">{error.next}</p>
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-2 right-2"
          aria-label={t('editor.dismiss')}
          onClick={onDismiss}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </Button>
      )}
    </div>
  );
}
