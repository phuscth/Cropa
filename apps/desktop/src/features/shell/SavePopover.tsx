import { Button, ChevronRightIcon, PopoverContent, SegmentedControl, SegmentedControlItem } from '@cropa/ui';
import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ExportFormat } from '../../lib/bindings.ts';
import { EXPORT_SIZES, type ExportSize } from '../editor/export/plan.ts';
import type { EditorActions } from './editor-actions.ts';

const FORMATS: readonly ExportFormat[] = ['png', 'jpeg', 'webp'];

const SAVE_KEYS = ['Ctrl', 'S'] as const;
const SAVE_AS_KEYS = ['Ctrl', 'Shift', 'S'] as const;

interface Props {
  options: EditorActions['exportOptions'];
  /** An export is running. */
  busy: boolean;
  /** Saves right away with the chosen format and size. */
  onSave: () => void;
  /** Opens the native save dialog with the chosen format and size. */
  onSaveAs: () => void;
}

/** The content of the Save popover: format, size, the sizes they give, and the two save actions. */
export function SavePopover({ options, busy, onSave, onSaveAs }: Props) {
  const { t } = useTranslation();
  const content = useRef<HTMLDivElement>(null);
  // How the user last pressed something, so focus on open can follow how the popover was opened.
  const lastInput = useRef<'pointer' | 'keyboard'>('pointer');
  useEffect(() => {
    const onPointer = () => { lastInput.current = 'pointer'; };
    const onKey = () => { lastInput.current = 'keyboard'; };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  const { format, size, sizeFixed, sizes, imageSize, output } = options;
  const dimensions = (box: { width: number; height: number }) => t('editor.details.size', box);

  return (
    <PopoverContent
      ref={content}
      align="end"
      sideOffset={6}
      className="flex w-80 flex-col gap-3.5 p-3"
      onOpenAutoFocus={(event) => {
        // Opened from the keyboard, focus goes to the first choice as usual. Opened with the
        // mouse, it stays on the popover itself, so the selected format shows no focus ring;
        // Tab still moves into the choices.
        if (lastInput.current === 'keyboard') return;
        event.preventDefault();
        content.current?.focus({ preventScroll: true });
      }}
    >
      <Field label={t('editor.export.format')}>
        <SegmentedControl
          aria-label={t('editor.export.format')}
          value={format}
          onValueChange={(next) => { options.setFormat(next as ExportFormat); }}
        >
          {FORMATS.map((f) => (
            <SegmentedControlItem key={f} value={f}>
              {f.toUpperCase()}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Field>

      <Field label={t('editor.export.size')}>
        <SegmentedControl
          aria-label={t('editor.export.size')}
          value={sizeFixed ? '1x' : size}
          disabled={sizeFixed}
          className="h-auto"
          onValueChange={(next) => { options.setSize(next as ExportSize); }}
        >
          {EXPORT_SIZES.map((s) => (
            <SegmentedControlItem
              key={s}
              value={s}
              className={sizeFixed ? 'h-[30px]' : 'h-10 flex-col gap-px px-1'}
            >
              <span>{s === '1x' ? s : s.toUpperCase()}</span>
              {!sizeFixed && (
                <span className="max-w-full truncate text-[10.5px] leading-none font-normal tracking-[-0.2px] tabular-nums opacity-70">
                  {t('editor.export.sizeValue', sizes[s])}
                </span>
              )}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        {sizeFixed && (
          <p className="text-caption tabular-nums">
            {t('editor.export.sizeFixed', { width: output.width, height: output.height })}
          </p>
        )}
      </Field>

      <div className="-mx-3 flex flex-col gap-3 border-t border-foreground/8 px-3 pt-3">
        <dl className="flex items-end justify-between gap-2 tabular-nums">
          <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-caption">{t('editor.details.image')}</dt>
            <dd className="truncate text-[12.5px] text-muted-foreground">{dimensions(imageSize)}</dd>
          </div>
          <ChevronRightIcon aria-hidden="true" className="mb-0.5 size-3.5 shrink-0 text-tertiary-foreground" />
          <div className="flex min-w-0 flex-col items-end gap-0.5">
            <dt className="text-caption">{t('editor.details.output')}</dt>
            <dd className="max-w-full truncate text-[12.5px] font-medium text-foreground">
              {`${format.toUpperCase()} · ${dimensions(output)}`}
            </dd>
          </div>
        </dl>

        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="h-9 px-3.5"
            aria-label={t('editor.export.saveAs')}
            tooltip={{ label: t('editor.export.saveAs'), keys: SAVE_AS_KEYS, side: 'top', align: 'start' }}
            disabled={busy}
            onClick={onSaveAs}
          >
            {t('editor.export.saveAs')}
          </Button>
          <Button
            className="min-w-0 flex-1 justify-between px-3.5"
            aria-keyshortcuts="Control+S"
            disabled={busy}
            onClick={onSave}
          >
            <span className="truncate">{t('editor.export.save')}</span>
            <span aria-hidden="true" className="flex gap-0.5">
              {SAVE_KEYS.map((key) => (
                <kbd
                  key={key}
                  className="flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-primary-foreground/15 px-1 font-sans text-[11px] leading-none font-medium text-primary-foreground/75"
                >
                  {key}
                </kbd>
              ))}
            </span>
          </Button>
        </div>
      </div>
    </PopoverContent>
  );
}

/** A choice with its name above it. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-tiny text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
