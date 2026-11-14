import {
  Button,
  DetailsCard,
  DetailsRow,
  OptionList,
  OptionListItem,
  PopoverContent,
  SegmentedControl,
  SegmentedControlItem,
} from '@cropa/ui';
import { useTranslation } from 'react-i18next';

import type { ExportFormat } from '../../lib/bindings.ts';
import { EXPORT_SIZES, type ExportSize } from '../editor/export/plan.ts';
import type { EditorActions } from './editor-actions.ts';

const FORMATS: readonly ExportFormat[] = ['png', 'jpeg', 'webp'];

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
  const { format, size, sizeFixed, sizes, imageSize, output } = options;
  const dimensions = (box: { width: number; height: number }) => t('editor.details.size', box);

  return (
    <PopoverContent align="end" className="flex w-72 flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-section">{t('editor.export.format')}</span>
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
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-section">{t('editor.export.size')}</span>
        <OptionList
          aria-label={t('editor.export.size')}
          value={sizeFixed ? '1x' : size}
          disabled={sizeFixed}
          onValueChange={(next) => { options.setSize(next as ExportSize); }}
        >
          {EXPORT_SIZES.map((s) => (
            <OptionListItem
              key={s}
              value={s}
              label={s === '1x' ? s : s.toUpperCase()}
              detail={sizeFixed ? undefined : t('editor.export.sizeValue', sizes[s])}
            />
          ))}
        </OptionList>
        {sizeFixed && (
          <p className="text-caption tabular-nums">
            {t('editor.export.sizeFixed', { width: output.width, height: output.height })}
          </p>
        )}
      </div>

      <DetailsCard>
        <DetailsRow label={t('editor.details.image')} value={dimensions(imageSize)} />
        <DetailsRow
          label={t('editor.details.output')}
          value={`${format.toUpperCase()} · ${dimensions(output)}`}
        />
      </DetailsCard>

      <div className="flex flex-col gap-2">
        <Button
          className="w-full"
          title={`${t('editor.export.save')} (Ctrl+S)`}
          disabled={busy}
          onClick={onSave}
        >
          {t('editor.export.save')}
        </Button>
        <Button
          variant="secondary"
          className="w-full"
          title={`${t('editor.export.saveAs')} (Ctrl+Shift+S)`}
          disabled={busy}
          onClick={onSaveAs}
        >
          {t('editor.export.saveAs')}
        </Button>
      </div>
    </PopoverContent>
  );
}
