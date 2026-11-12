import { cn } from '@cropa/ui';
import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { recordAccelerator } from './accelerator.ts';

interface Props {
  value: string;
  disabled?: boolean;
  onChange: (accelerator: string) => void;
}

/** Focus the field, press a key combination, and it reports the accelerator. */
export function ShortcutField({ value, disabled = false, onChange }: Props) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    const result = recordAccelerator(event);
    if (result.kind === 'pending') return;
    setRecording(false);
    event.currentTarget.blur();
    if (result.kind === 'done' && result.accelerator !== value) onChange(result.accelerator);
  };

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={t('settings.shortcut.label')}
      onClick={() => { setRecording(true); }}
      onBlur={() => { setRecording(false); }}
      onKeyDown={onKeyDown}
      className={cn(
        'h-8 w-full rounded-md border bg-background px-3 text-left font-mono text-sm shadow-xs outline-none',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50',
        recording && 'ring-[3px] ring-ring/50',
      )}
    >
      {recording ? (
        <span className="font-sans text-muted-foreground">{t('settings.shortcut.recording')}</span>
      ) : (
        value
      )}
    </button>
  );
}
