import {
  Button,
  DetailsCard,
  DetailsRow,
  PopoverContent,
  SegmentedControl,
  SegmentedControlItem,
} from '@cropa/ui';
import { useTranslation } from 'react-i18next';

import type { ExportFormat } from '../../lib/bindings.ts';
import type { ExportScale } from '../editor/export/plan.ts';
import type { EditorActions } from './editor-actions.ts';

const FORMATS: readonly ExportFormat[] = ['png', 'jpeg', 'webp'];
const SCALES: readonly ExportScale[] = [1, 2, 3];

interface Props {
  options: EditorActions['exportOptions'];
  /** An export is running. */
  busy: boolean;
  /** Saves right away with the chosen format and scale. */
  onSave: () => void;
  /** Opens the native save dialog with the chosen format and scale. */
  onSaveAs: () => void;
}

/** The content of the Save popover: format, scale, the sizes they give, and the two save actions. */
export function SavePopover({ options, busy, onSave, onSaveAs }: Props) {
  const { t } = useTranslation();
  const { format, scale, scaleFixed, scaleLabels, imageSize, output } = options;
  const size = (box: { width: number; height: number }) => t('editor.details.size', box);

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
        <span className="text-section">{t('editor.export.scale')}</span>
        <SegmentedControl
          aria-label={t('editor.export.scale')}
          value={String(scaleFixed ? 1 : scale)}
          disabled={scaleFixed}
          onValueChange={(next) => { options.setScale(Number(next) as ExportScale); }}
        >
          {SCALES.map((s) => {
            const label = scaleLabels[s];
            return (
              <SegmentedControlItem key={s} value={String(s)}>
                {`${String(s)}x`}
                {label !== undefined && !scaleFixed && (
                  <span className="text-caption ml-1 tabular-nums">{label}</span>
                )}
              </SegmentedControlItem>
            );
          })}
        </SegmentedControl>
        {scaleFixed && (
          <p className="text-caption tabular-nums">
            {t('editor.export.scaleFixed', { width: output.width, height: output.height })}
          </p>
        )}
      </div>

      <DetailsCard>
        <DetailsRow label={t('editor.details.image')} value={size(imageSize)} />
        <DetailsRow
          label={t('editor.details.output')}
          value={`${format.toUpperCase()} · ${size(output)}`}
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
