import { Button } from '@cropa/ui';
import { useTranslation } from 'react-i18next';

import type { UserError } from './errors.ts';

interface Props {
  error: UserError;
  /** When given, the notice shows a close button. */
  onDismiss?: () => void;
}

export function ErrorNotice({ error, onDismiss }: Props) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="relative rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
    >
      <p className={onDismiss ? 'pr-6 font-medium text-destructive' : 'font-medium text-destructive'}>
        {error.what}
      </p>
      <p className="mt-1 text-muted-foreground">{error.why}</p>
      <p className="mt-1">{error.next}</p>
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-1 right-1 size-6"
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
