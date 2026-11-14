import { AddIcon, Button, CameraIcon, cn, ImageAddIcon, ImageIcon } from '@cropa/ui';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { pickImageFile } from './import-image.ts';

interface Props {
  /** The screenshot's rectangle in CSS px, relative to the preview canvas. */
  rect: { x: number; y: number; w: number; h: number };
  /** The corner radius of the screenshot, in CSS px. */
  radius: number;
  /** A file is being dragged over the window. */
  dragging: boolean;
  /** A file is being opened. */
  importing: boolean;
  shortcut: string | undefined;
  onFile: (file: File) => void;
  onCapture: () => void;
}

// Both layers share one grid cell, so the column is as tall as the taller of the two.
const LAYER =
  'col-start-1 row-start-1 flex flex-col items-center justify-center gap-[1.5cqw] text-center transition-opacity duration-150';

/**
 * Stands in for the screenshot before there is an image: the preview has already
 * drawn the frame around it, so this card is transparent and only holds the
 * invitation to drop, paste or pick an image, and the capture button.
 */
export function EmptyCanvas({ rect, radius, dragging, importing, shortcut, onFile, onCapture }: Props) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  // While a file is over the window or being opened, the card does not offer the file picker.
  const locked = dragging || importing;
  const iconBox = { width: 'clamp(56px, 14cqw, 112px)', height: 'clamp(40px, 10cqw, 80px)' };
  const icon = { width: '58%', height: '58%' };
  const title = { fontSize: 'clamp(20px, 6cqw, 48px)', lineHeight: 1.1 };
  const subtitle = { fontSize: 'clamp(12px, 3cqw, 24px)', lineHeight: 1.25 };

  // The picker button is an empty peer; the layers below it follow its hover and focus.
  const hideOnPick = locked
    ? ''
    : '[.peer:hover~*_&]:opacity-0 [.peer:focus-visible~*_&]:opacity-0';
  const showOnPick = locked
    ? ''
    : '[.peer:hover~*_&]:opacity-100 [.peer:focus-visible~*_&]:opacity-100';

  return (
    <div
      className={cn(
        '@container absolute flex flex-col items-center justify-center overflow-hidden px-[6cqw] py-3 transition-colors duration-150',
        dragging && 'bg-info-soft ring-2 ring-inset ring-ring',
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, borderRadius: radius }}
    >
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const input = event.target;
          const file = input.files && pickImageFile(input.files);
          // Cleared so the same file can be picked again.
          input.value = '';
          if (file) onFile(file);
        }}
      />
      <button
        type="button"
        disabled={importing}
        aria-label={`${t('editor.drop.selectTitle')}. ${t('editor.drop.selectSubtitle')}`}
        className="peer absolute inset-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-progress"
        style={{ borderRadius: 'inherit' }}
        onClick={() => { fileInput.current?.click(); }}
      />
      <div className="pointer-events-none relative z-10 flex max-w-full flex-col items-center gap-[2cqw] text-tertiary-foreground">
        <div className="grid">
          <div className={cn(LAYER, hideOnPick)}>
            <span className="relative mb-[1cqw]" style={iconBox} aria-hidden="true">
              <ImageIcon className="absolute left-0 top-1/2 -translate-y-1/2 -rotate-[8deg]" style={icon} />
              <CameraIcon className="absolute right-0 top-1/2 -translate-y-1/2 rotate-[8deg]" style={icon} />
              <span className="absolute top-1/2 left-1/2 flex size-[34%] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <AddIcon className="size-[70%]" />
              </span>
            </span>
            <span className="font-medium tracking-tight text-balance" style={title}>
              {dragging ? t('editor.drop.dropTitle') : t('editor.drop.title')}
            </span>
            <span className="font-medium tracking-tight" style={subtitle}>
              {importing ? t('editor.drop.opening') : t('editor.drop.subtitle')}
            </span>
          </div>
          <div className={cn(LAYER, 'opacity-0', showOnPick)} aria-hidden="true">
            <ImageAddIcon className="mb-[1cqw]" style={{ width: 'clamp(32px, 8cqw, 64px)', height: 'clamp(32px, 8cqw, 64px)' }} />
            <span className="font-medium tracking-tight text-balance" style={title}>
              {t('editor.drop.selectTitle')}
            </span>
            <span className="font-medium tracking-tight text-balance" style={subtitle}>
              {t('editor.drop.selectSubtitle')}
            </span>
          </div>
        </div>
        {/* Over the picker button, so hovering them leaves the card idle. */}
        <Button size="sm" className="pointer-events-auto" disabled={locked} onClick={onCapture}>
          {t('menu.file.captureRegion')}
        </Button>
        {shortcut && (
          <p className="hidden max-w-sm text-center text-control-sm font-normal @lg:block">
            {t('editor.hint', { shortcut })}
          </p>
        )}
      </div>
    </div>
  );
}
