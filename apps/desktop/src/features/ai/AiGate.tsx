import { Button } from '@cropa/ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { AiAccess } from './access.ts';

interface Props {
  access: AiAccess;
  /** Shown next to the hint while AI is locked. */
  onSetUp?: (() => void) | undefined;
  /** Renders the AI control; `enabled` is false until a provider is chosen. */
  children: (enabled: boolean) => ReactNode;
}

/** Shows an AI control disabled, with a hint, until the user has set up AI. */
export function AiGate({ access, onSetUp, children }: Props) {
  const { t } = useTranslation();
  const enabled = access.state === 'ready';
  return (
    <div className="flex flex-col items-start gap-1">
      {children(enabled)}
      {access.state === 'locked' && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('ai.locked.hint')}
          {onSetUp && (
            <Button variant="ghost" size="sm" onClick={onSetUp}>
              {t('ai.locked.setUp')}
            </Button>
          )}
        </p>
      )}
    </div>
  );
}
