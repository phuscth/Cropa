import {
  Button,
  ColorInput,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Slider,
} from '@cropa/ui';
import { useTranslation } from 'react-i18next';

import type { Annotate, ValueKind } from './use-annotate.ts';

const SWATCHES = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#111827', '#ffffff'];

/** The one slider each kind of mark has. */
const SLIDERS: Partial<Record<string, { kind: ValueKind; min: number; max: number; label: string }>> = {
  arrow: { kind: 'strokeWidth', min: 1, max: 64, label: 'strokeWidth' },
  rect: { kind: 'strokeWidth', min: 1, max: 64, label: 'strokeWidth' },
  text: { kind: 'fontSize', min: 8, max: 256, label: 'fontSize' },
  step: { kind: 'stepSize', min: 12, max: 256, label: 'stepSize' },
  blur: { kind: 'strength', min: 1, max: 64, label: 'strength' },
  pixelate: { kind: 'strength', min: 1, max: 64, label: 'strength' },
};

const COLORED = new Set(['arrow', 'rect', 'text', 'step']);

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4.5h10M6.5 4.5v-1.5h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5" />
    </svg>
  );
}

/** Colour, size and delete for the selected mark, or for the next one when none is selected. */
export function AnnotationProperties({ annotate }: { annotate: Annotate }) {
  const { t } = useTranslation();
  const { selectedAnnotation, tool, style } = annotate;
  const type = selectedAnnotation?.type ?? tool;
  const slider = SLIDERS[type];
  const colored = COLORED.has(type);
  const color = selectedAnnotation?.style?.color ?? style.color;
  const custom = !SWATCHES.includes(color.toLowerCase());
  const label = slider ? t(`editor.annotate.${slider.label}`) : '';
  const current = slider ? annotate.valueOf(slider.kind) : 0;

  return (
    <div
      role="toolbar"
      aria-label={t('editor.annotate.properties')}
      className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-xl border bg-popover px-3 py-1.5 shadow-md"
    >
      {colored && (
        <div role="group" aria-label={t('editor.annotate.color')} className="flex items-center gap-1">
          {SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={hex}
              aria-pressed={color.toLowerCase() === hex}
              onClick={() => { annotate.setColor(hex); }}
              style={{ backgroundColor: hex }}
              className={cn(
                'size-5 rounded-full border outline-none focus-visible:ring-4 focus-visible:ring-primary/16',
                color.toLowerCase() === hex && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
              )}
            />
          ))}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t('editor.annotate.otherColor')}
                title={t('editor.annotate.otherColor')}
                aria-pressed={custom}
                style={custom ? { backgroundColor: color } : undefined}
                className={cn(
                  'size-5 rounded-full border outline-none focus-visible:ring-4 focus-visible:ring-primary/16',
                  !custom && 'bg-[conic-gradient(red,yellow,lime,aqua,blue,magenta,red)]',
                  custom && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                )}
              />
            </PopoverTrigger>
            <PopoverContent align="start">
              <ColorInput
                value={color}
                swatchLabel={t('editor.annotate.otherColor')}
                textLabel={t('editor.annotate.color')}
                onValueCommit={annotate.setColor}
              />
            </PopoverContent>
          </Popover>
        </div>
      )}
      {slider && (
        <div className="flex w-44 items-center gap-2 text-sm">
          <span className="shrink-0">{label}</span>
          <Slider
            aria-label={label}
            min={Math.min(slider.min, current)}
            max={Math.max(slider.max, current)}
            step={1}
            value={[current]}
            onValueChange={([next]) => {
              if (next !== undefined) annotate.previewValue(slider.kind, next);
            }}
            // Radix commits a keyboard change before it reports the value, so wait for the
            // preview to be dispatched; otherwise the drag would stay open.
            onValueCommit={() => { queueMicrotask(annotate.commitValue); }}
          />
          <span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">
            {Math.round(current)}
          </span>
        </div>
      )}
      {selectedAnnotation && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('editor.annotate.delete')}
          title={`${t('editor.annotate.delete')} (Del)`}
          onClick={annotate.removeSelected}
        >
          <TrashIcon />
        </Button>
      )}
    </div>
  );
}
