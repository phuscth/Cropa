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
        'focus-ring h-9 w-full rounded-lg border border-input bg-card px-3 text-left font-mono text-control-sm',
        'transition-[border-color,box-shadow] duration-150 ease-enter hover:border-foreground/25',
        'focus-visible:border-ring disabled:opacity-50',
        recording && 'border-ring outline-2 outline-offset-2 outline-ring',
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
