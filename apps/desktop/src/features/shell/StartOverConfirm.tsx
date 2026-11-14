import { Button, cn, Popover, PopoverContent, PopoverTrigger, RestartIcon } from '@cropa/ui';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface Props {
  /** There is nothing to start over from, or an export is running. */
  disabled: boolean;
  /** The window is maximized, so its root has no rounded corners for the backdrop to follow. */
  maximized: boolean;
  onConfirm: () => void;
}

/** A small empty canvas with its card and the add badge, in the colours of the theme. */
function Illustration() {
  return (
    <svg viewBox="0 0 120 92" className="h-[92px] w-[120px]" fill="none" aria-hidden="true">
      <rect width="120" height="92" rx="20" className="fill-muted" />
      <rect x="22" y="18" width="76" height="56" rx="12" className="fill-popover" />
      <rect x="32" y="28" width="56" height="8" rx="4" className="fill-foreground/10" />
      <rect x="32" y="42" width="36" height="6" rx="3" className="fill-foreground/10" />
      <circle cx="82" cy="62" r="14" className="fill-primary" />
      <path
        d="M82 56v12M76 62h12"
        className="stroke-primary-foreground"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Dims the page behind the card. It stays mounted while it fades out, and never takes
 * a click, so the dismissing press is the card's own. The window is transparent outside its
 * rounded corners, so the backdrop is rounded the same way unless the window is maximized.
 */
function Backdrop({ open, maximized }: { open: boolean; maximized: boolean }) {
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  if (!shown) return null;
  return createPortal(
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none fixed inset-0 z-[60] bg-black/30',
        !maximized && 'rounded-2xl',
        open ? 'animate-fade-in' : 'animate-fade-out',
      )}
      onAnimationEnd={() => { if (!open) setShown(false); }}
    />,
    document.body,
  );
}

const PILL =
  'h-12 flex-1 cursor-pointer rounded-full text-base font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/**
 * The "Start over" button of the title bar and the card that asks before it clears the editor.
 * The page behind the card is dimmed, the title bar included.
 */
export function StartOverConfirm({ disabled, maximized, onConfirm }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  // A card left open must not come back when the button is enabled again.
  if (disabled && open) setOpen(false);

  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('editor.startOver.label')}
          tooltip={{ label: t('editor.startOver.label') }}
          disabled={disabled}
        >
          <RestartIcon />
        </Button>
      </PopoverTrigger>
      <Backdrop open={open} maximized={maximized} />
      <PopoverContent
        align="center"
        sideOffset={8}
        className={cn(
          'z-[70] flex w-80 flex-col items-center gap-3 rounded-[32px] p-6 data-[state=closed]:animate-confirm-out',
          'animate-confirm-in',
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
      >
        <Illustration />
        <h2 className="text-[28px] leading-[38px] font-medium tracking-tight">{t('editor.startOver.title')}</h2>
        <p className="text-center text-[12.5px] text-muted-foreground">{t('editor.startOver.caption')}</p>
        <div className="mt-2 flex w-full gap-3">
          <button
            ref={cancel}
            type="button"
            className={cn(PILL, 'bg-foreground/6 text-foreground hover:bg-foreground/10')}
            onClick={() => { setOpen(false); }}
          >
            {t('editor.startOver.cancel')}
          </button>
          <button
            type="button"
            className={cn(PILL, 'bg-foreground text-background hover:bg-foreground/85')}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {t('editor.startOver.confirm')}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
