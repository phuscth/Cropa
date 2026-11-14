import { AddIcon, cn } from '@cropa/ui';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, events, type HistoryItem } from '../../lib/bindings.ts';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';
import { pickImageFile } from './import-image.ts';

const MAX_RECENT = 20;

interface Props {
  /** The button that opened the picker: a press on it does not count as outside. */
  anchor: RefObject<HTMLElement | null>;
  /** `returnFocus` is true when the picker was closed from the keyboard. */
  onClose: (returnFocus: boolean) => void;
  onFile: (file: File) => void;
  onError: (error: UserError) => void;
}

const TILE =
  'size-[62px] shrink-0 cursor-pointer rounded-[14px] bg-foreground/12 backdrop-blur-[4px] backdrop-saturate-150 transition-all duration-300 hover:-translate-y-px active:scale-[0.97] motion-reduce:active:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function Tile({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <span className="flex w-[72px] flex-col items-center gap-1.5">
      {children}
      <span className="max-w-full truncate text-[12.5px] leading-tight text-muted-foreground">{caption}</span>
    </span>
  );
}

function shortTime(at: number, language: string): string {
  const date = new Date(at);
  const today = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(
    language,
    today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' },
  ).format(date);
}

interface RecentProps {
  item: HistoryItem;
  root: RefObject<HTMLElement | null>;
  cache: Map<string, string>;
  busy: boolean;
  onOpen: (id: string) => void;
  onError: (error: UserError) => void;
}

/** A recent capture. Its thumbnail loads once the tile scrolls into view of the row. */
function RecentTile({ item, root, cache, busy, onOpen, onError }: RecentProps) {
  const { t, i18n } = useTranslation();
  const tile = useRef<HTMLButtonElement>(null);
  const [thumbnail, setThumbnail] = useState(() => cache.get(item.id));
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; });
  const caption = item.capturedAt === null ? '' : shortTime(item.capturedAt, i18n.language);
  const full = item.capturedAt === null ? '' : new Date(item.capturedAt).toLocaleString(i18n.language);

  useEffect(() => {
    const element = tile.current;
    if (!element || cache.has(item.id)) return;
    let alive = true;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        commands.getHistoryThumbnail(item.id).then(
          (result) => {
            if (result.status === 'ok') {
              cache.set(item.id, result.data);
              if (alive) setThumbnail(result.data);
            } else if (alive) {
              onError(describeCommandError(tRef.current, result.error));
            }
          },
          (cause: unknown) => { if (alive) onError(describeUnexpected(tRef.current, cause)); },
        );
      },
      { root: root.current },
    );
    observer.observe(element);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [item.id, root, cache, onError]);

  return (
    <Tile caption={caption}>
      <button
        ref={tile}
        type="button"
        data-id={item.id}
        aria-busy={busy}
        aria-label={t('editor.picker.recentAlt', { time: full })}
        className={cn(TILE, 'overflow-hidden', busy && 'cursor-progress opacity-60')}
        onClick={() => { onOpen(item.id); }}
      >
        {thumbnail && <img src={thumbnail} alt="" draggable={false} className="size-full object-cover" />}
      </button>
    </Tile>
  );
}

/**
 * The picker an empty editor opens: a tile that adds a file from the computer, then
 * the latest captures from the history. It is not modal; Escape or a press outside closes it.
 */
export function ImagePicker({ anchor, onClose, onFile, onError }: Props) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<HistoryItem[]>([]);
  const [thumbnails] = useState(() => new Map<string, string>());
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; });
  const latest = useRef({ onClose, onError });
  useEffect(() => { latest.current = { onClose, onError }; });

  useEffect(() => {
    row.current?.querySelector('button')?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    let latestLoad = 0;
    const load = () => {
      const seq = ++latestLoad;
      // Only the newest answer counts: loads can overlap and finish out of order.
      const current = () => alive && seq === latestLoad;
      void (async () => {
        try {
          const settings = await commands.getSettings();
          if (!settings.saveHistory) {
            if (current()) setRecent([]);
            return;
          }
          const result = await commands.listHistory();
          if (!current()) return;
          if (result.status === 'ok') setRecent(result.data.slice(0, MAX_RECENT));
          else latest.current.onError(describeCommandError(tRef.current, result.error));
        } catch (cause) {
          if (current()) latest.current.onError(describeUnexpected(tRef.current, cause));
        }
      })();
    };
    load();
    const unlisten = events.historyChanged.listen(load);
    return () => {
      alive = false;
      void unlisten.then((off) => { off(); });
    };
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // The notices float over the picker and are part of it.
      if (dialog.current?.contains(target) || anchor.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-picker-keep]')) return;
      latest.current.onClose(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      latest.current.onClose(true);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor]);

  const move = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    const tiles = Array.from(row.current?.querySelectorAll('button') ?? []);
    const next = tiles[tiles.indexOf(document.activeElement as HTMLButtonElement) + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  // The picker stays open while a capture opens: it closes when the image loads, and a failure
  // leaves it, with focus on the tile, for another try.
  const [opening, setOpening] = useState<string>();
  const openingNow = useRef(false);
  const open = (id: string) => {
    if (openingNow.current) return;
    openingNow.current = true;
    setOpening(id);
    const failed = (error: UserError) => {
      openingNow.current = false;
      setOpening(undefined);
      onError(error);
      row.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus();
    };
    commands.openHistoryInEditor(id).then(
      (result) => {
        if (result.status === 'error') failed(describeCommandError(tRef.current, result.error));
      },
      (cause: unknown) => { failed(describeUnexpected(tRef.current, cause)); },
    );
  };

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-label={t('editor.picker.title')}
      className="absolute inset-x-0 top-0 z-30 flex h-[158px] animate-picker-in flex-col items-center justify-center gap-3"
      onKeyDown={move}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[285px] bg-linear-to-b from-canvas/80 to-transparent"
      />
      <h2 className="text-[17px] font-medium tracking-tight text-foreground">{t('editor.picker.title')}</h2>
      <div ref={row} className="flex w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto flex gap-3 px-6 py-1">
          <Tile caption={t('editor.picker.add')}>
            <button
              type="button"
              aria-label={t('editor.picker.add')}
              className={cn(TILE, 'flex items-center justify-center text-foreground/60')}
              onClick={() => { fileInput.current?.click(); }}
            >
              <AddIcon className="size-7" />
            </button>
          </Tile>
          {recent.map((item) => (
            <RecentTile
              key={item.id}
              item={item}
              root={row}
              cache={thumbnails}
              busy={opening === item.id}
              onOpen={open}
              onError={onError}
            />
          ))}
        </div>
      </div>
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
          if (file) {
            onFile(file);
            onClose(false);
          }
        }}
      />
    </div>
  );
}
