import { Button, Checkbox, CheckIcon, cn, CopyIcon, DeleteIcon, EditorIcon } from '@cropa/ui';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, type CommandError, type HistoryItem } from '../../lib/bindings.ts';

export type Outcome<T> = { status: 'ok'; data: T } | { status: 'error'; error: CommandError };

export type RunCommand = <T>(call: () => Promise<Outcome<T>>, keepNotice?: boolean) => Promise<T | undefined>;

/** How long the copy button shows its check mark. */
const COPIED_MS = 1500;

interface HistoryCardProps {
  item: HistoryItem;
  /** The full localised date and time, for names and alternative texts. */
  when: string;
  /** The short time of day shown under the picture. */
  time: string;
  run: RunCommand;
  selecting: boolean;
  selected: boolean;
  leaving: boolean;
  onToggle: (id: string, shiftKey: boolean) => void;
  onDelete: (id: string) => void;
}

export function HistoryCard({
  item,
  when,
  time,
  run,
  selecting,
  selected,
  leaving,
  onToggle,
  onDelete,
}: HistoryCardProps) {
  const { t } = useTranslation();
  const [thumbnail, setThumbnail] = useState<string>();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number>(undefined);
  // The box takes the capture's own shape before the thumbnail arrives, so nothing moves when it does.
  const ratio = item.width > 0 && item.height > 0 ? item.width / item.height : 4 / 3;

  useEffect(() => {
    let mounted = true;
    void run(() => commands.getHistoryThumbnail(item.id), true).then((url) => {
      if (mounted && url) setThumbnail(url);
    });
    return () => { mounted = false; };
  }, [item.id, run]);

  useEffect(() => () => { window.clearTimeout(copiedTimer.current); }, []);

  const copy = async () => {
    window.clearTimeout(copiedTimer.current);
    setCopied(false);
    const done = await run(() => commands.copyHistoryImage(item.id));
    if (done === undefined) return;
    setCopied(true);
    copiedTimer.current = window.setTimeout(() => { setCopied(false); }, COPIED_MS);
  };

  return (
    <li
      data-history-id={item.id}
      className={cn(
        'group/card relative isolate flex flex-col gap-2.5 outline-none',
        selecting && 'cursor-pointer select-none',
        leaving && 'pointer-events-none animate-menu-out',
      )}
      onClick={selecting ? (event) => { onToggle(item.id, event.shiftKey); } : undefined}
    >
      <div
        className={cn(
          'relative aspect-[4/3] rounded-xl bg-secondary transition-shadow duration-150 ease-enter',
          selected && 'ring-2 ring-foreground ring-offset-2 ring-offset-panel',
          selecting && !selected && 'hover:ring-1 hover:ring-foreground/15',
        )}
      >
        <div className="absolute inset-3 flex items-center justify-center [container-type:size]">
          <div
            style={{ '--ratio': String(ratio) } as CSSProperties}
            className={cn(
              'relative h-[min(100cqh,calc(100cqw/var(--ratio)))] w-[min(100cqw,calc(100cqh*var(--ratio)))] min-h-1 min-w-1 overflow-hidden rounded-md shadow-soft ring-1 ring-foreground/[0.06] transition-[translate,scale,box-shadow] duration-200 ease-enter',
              !selecting && 'group-hover/card:-translate-y-0.5 group-hover/card:shadow-soft-hover',
              selected && 'scale-[0.94]',
            )}
          >
            {thumbnail ? (
              <img
                src={thumbnail}
                alt={t('history.thumbnailAlt', { time: when })}
                draggable={false}
                className="size-full animate-fade-in object-cover"
              />
            ) : (
              <div aria-hidden="true" className="size-full bg-foreground/[0.06] motion-safe:animate-pulse" />
            )}
          </div>
        </div>
        <Checkbox
          checked={selected}
          aria-label={t('history.selectCapture', { time: when })}
          className={cn(
            'absolute top-2.5 left-2.5 z-10 transition-opacity duration-150 ease-enter',
            selecting
              ? 'opacity-100'
              : 'opacity-0 group-has-[:focus-visible]/card:opacity-100 group-hover/card:opacity-100',
          )}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(item.id, event.shiftKey);
          }}
        />
        {!selecting && (
          <div
            className={cn(
              'absolute inset-x-2.5 bottom-2.5 z-10 flex translate-y-1 items-center justify-between gap-2 opacity-0 transition-[opacity,translate] duration-150 ease-enter group-has-[:focus-visible]/card:translate-y-0 group-has-[:focus-visible]/card:opacity-100 group-hover/card:translate-y-0 group-hover/card:opacity-100',
              copied && 'translate-y-0 opacity-100',
            )}
          >
            <Button
              size="sm"
              data-history-open=""
              className="h-8 rounded-full px-3.5 shadow-soft"
              aria-label={t('history.openCapture', { time: when })}
              onClick={() => { void run(() => commands.openHistoryInEditor(item.id)); }}
            >
              <EditorIcon />
              {t('history.open')}
            </Button>
            <div className="flex gap-1.5">
              <Button
                variant="secondary"
                size="icon-sm"
                className="rounded-full bg-popover/90 text-foreground shadow-soft backdrop-blur-sm hover:bg-popover"
                aria-label={t('history.copyCapture', { time: when })}
                tooltip={{ label: copied ? t('history.copied') : t('history.copy'), side: 'top' }}
                onClick={() => { void copy(); }}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </Button>
              <Button
                variant="secondary"
                size="icon-sm"
                className="rounded-full bg-popover/90 text-foreground shadow-soft backdrop-blur-sm hover:bg-popover hover:text-destructive"
                aria-label={t('history.deleteCapture', { time: when })}
                tooltip={{ label: t('history.delete'), side: 'top', align: 'end' }}
                onClick={() => { onDelete(item.id); }}
              >
                <DeleteIcon />
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-2 px-1">
        <span className="truncate text-control-sm">{time}</span>
        <span className="shrink-0 text-caption tabular-nums">
          {t('history.size', { width: item.width, height: item.height })}
        </span>
      </div>
      <span role="status" className="sr-only">
        {copied ? t('history.copied') : ''}
      </span>
    </li>
  );
}
