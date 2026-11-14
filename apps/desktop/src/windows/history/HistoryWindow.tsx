import { Button, Checkbox, cn } from '@cropa/ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, events, type CommandError, type HistoryItem } from '../../lib/bindings.ts';
import { useViewActive } from '../../features/shell/view-active.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';
import { selectRange, toggleId } from './history-selection.ts';

type Outcome<T> = { status: 'ok'; data: T } | { status: 'error'; error: CommandError };

/** Matches the 140 ms exit animation, plus a frame. */
const LEAVE_MS = 150;

const NONE: ReadonlySet<string> = new Set();

function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export function HistoryView() {
  const active = useViewActive();
  const { t } = useTranslation();
  const [items, setItems] = useState<HistoryItem[]>();
  const [saveHistory, setSaveHistory] = useState(true);
  const [error, setError] = useState<UserError>();
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(NONE);
  const [anchor, setAnchor] = useState<string>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(NONE);

  const reload = useCallback(() => {
    commands
      .listHistory()
      .then((result) => {
        if (result.status === 'ok') {
          const listed = new Set(result.data.map((item) => item.id));
          setItems(result.data);
          setSelected((current) =>
            [...current].every((id) => listed.has(id)) ? current : new Set([...current].filter((id) => listed.has(id))),
          );
          setAnchor((current) => (current !== undefined && listed.has(current) ? current : undefined));
        } else setError(describeCommandError(t, result.error));
      })
      .catch((cause: unknown) => { setError(describeUnexpected(t, cause)); })
      .finally(() => { setLeaving(NONE); });
  }, [t]);

  /** Run a command; show its error, and refresh the list when the capture is gone. */
  const run = useCallback(
    async <T,>(call: () => Promise<Outcome<T>>, keepNotice = false): Promise<T | undefined> => {
      if (!keepNotice) setError(undefined);
      try {
        const result = await call();
        if (result.status === 'ok') return result.data;
        setError(describeCommandError(t, result.error));
        if (result.error.kind === 'HistoryMissing') reload();
      } catch (cause) {
        setError(describeUnexpected(t, cause));
      }
      return undefined;
    },
    [t, reload],
  );

  useEffect(() => {
    reload();
    const unlisten = events.historyChanged.listen(() => {
      setSelected(NONE);
      setAnchor(undefined);
      setConfirmingDelete(false);
      reload();
    });
    return () => {
      void unlisten.then((off) => { off(); });
    };
  }, [reload, t]);

  // The "history is off" setting is changed in the Settings view, so read it
  // whenever this view comes to the front.
  useEffect(() => {
    if (!active) return;
    void commands
      .getSettings()
      .then((settings) => { setSaveHistory(settings.saveHistory); })
      .catch((cause: unknown) => { setError(describeUnexpected(t, cause)); });
  }, [active, t]);

  const deleteAll = async () => {
    setConfirmingDeleteAll(false);
    await run(() => commands.deleteAllHistory());
    reload();
  };

  const count = items?.length ?? 0;
  const ids = items?.map((item) => item.id) ?? [];
  const allSelected = count > 0 && selected.size === count;

  const leaveSelecting = useCallback(() => {
    setSelecting(false);
    setSelected(NONE);
    setAnchor(undefined);
  }, []);

  const toggle = (id: string, shiftKey: boolean) => {
    setSelecting(true);
    setConfirmingDeleteAll(false);
    setSelected(shiftKey ? selectRange(selected, ids, anchor, id) : toggleId(selected, id));
    if (!shiftKey) setAnchor(id);
  };

  const selectAll = () => {
    setSelecting(true);
    setConfirmingDeleteAll(false);
    setSelected(new Set(ids));
  };

  const deleteSelected = async () => {
    const chosen = ids.filter((id) => selected.has(id));
    setConfirmingDelete(false);
    setError(undefined);
    setLeaving(new Set(chosen));
    try {
      await new Promise((resolve) => setTimeout(resolve, LEAVE_MS));
      const result = await commands.deleteHistoryImages(chosen);
      if (result.status === 'ok') {
        // A capture that is already gone is what the user asked for.
        const failed = result.data.filter((failure) => failure.error.kind !== 'HistoryMissing');
        const first = failed[0];
        if (first) {
          const reason = describeCommandError(t, first.error);
          setError({
            what: t('history.deleteSelectedFailed', { count: failed.length }),
            why: reason.why,
            next: reason.next,
          });
        }
      } else {
        setError(describeCommandError(t, result.error));
      }
    } catch (cause) {
      setError(describeUnexpected(t, cause));
    } finally {
      leaveSelecting();
      reload();
    }
  };

  // Keyboard shortcuts only while this view is in front: the views stay mounted.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (confirmingDelete) setConfirmingDelete(false);
        else if (selecting) leaveSelecting();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'a' &&
        !isTextField(event.target) &&
        count > 0
      ) {
        event.preventDefault();
        setSelecting(true);
        setConfirmingDeleteAll(false);
        setSelected(new Set(items?.map((item) => item.id)));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [active, confirmingDelete, selecting, count, items, leaveSelecting]);

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 px-8 pt-8 pb-2">
        <h1 className="text-title">{t('history.title')}</h1>
        {items && items.length > 0 && (
          <span className="text-control-sm text-muted-foreground">{t('history.count', { total: count })}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {confirmingDelete ? (
            <>
              <span className="text-sm">
                {t('history.confirm.deleteSelected', { count: selected.size })}
              </span>
              <Button variant="destructive" size="sm" onClick={() => { void deleteSelected(); }}>
                {t('history.delete')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setConfirmingDelete(false); }}>
                {t('history.confirm.cancel')}
              </Button>
            </>
          ) : selecting ? (
            <>
              <span className="text-sm tabular-nums" aria-live="polite">
                {t('history.selectedCount', { count: selected.size })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={allSelected ? () => { setSelected(NONE); setAnchor(undefined); } : selectAll}
              >
                {allSelected ? t('history.clearSelection') : t('history.selectAll')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={selected.size === 0}
                onClick={() => { setConfirmingDelete(true); }}
              >
                {t('history.delete')}
              </Button>
              <Button variant="outline" size="sm" onClick={leaveSelecting}>
                {t('history.done')}
              </Button>
            </>
          ) : confirmingDeleteAll ? (
            <>
              <span className="text-sm">{t('history.confirm.message')}</span>
              <Button variant="destructive" size="sm" onClick={() => { void deleteAll(); }}>
                {t('history.deleteAll')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setConfirmingDeleteAll(false); }}
              >
                {t('history.confirm.cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={count === 0}
                onClick={() => { setSelecting(true); setConfirmingDeleteAll(false); }}
              >
                {t('history.select')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={count === 0}
                onClick={() => { setConfirmingDeleteAll(true); }}
              >
                {t('history.deleteAll')}
              </Button>
            </>
          )}
        </div>
      </header>

      <section className="flex-1 overflow-y-auto p-8 pt-6">
        {error && (
          <div className="mb-6">
            <ErrorNotice error={error} />
          </div>
        )}
        {items?.length === 0 && (
          <div className="flex flex-col items-center gap-1 py-16 text-center text-sm text-muted-foreground">
            <p className="text-heading text-foreground">{t('history.empty')}</p>
            {!saveHistory && <p>{t('history.savingOff')}</p>}
          </div>
        )}
        {items && items.length > 0 && (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {items.map((item) => (
              <HistoryCard
                key={item.id}
                item={item}
                run={run}
                selecting={selecting}
                selected={selected.has(item.id)}
                leaving={leaving.has(item.id)}
                onToggle={toggle}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

interface HistoryCardProps {
  item: HistoryItem;
  run: <T>(call: () => Promise<Outcome<T>>, keepNotice?: boolean) => Promise<T | undefined>;
  selecting: boolean;
  selected: boolean;
  leaving: boolean;
  onToggle: (id: string, shiftKey: boolean) => void;
}

function HistoryCard({ item, run, selecting, selected, leaving, onToggle }: HistoryCardProps) {
  const { t, i18n } = useTranslation();
  const [thumbnail, setThumbnail] = useState<string>();
  const [copied, setCopied] = useState(false);
  const when = item.capturedAt === null ? '' : new Date(item.capturedAt).toLocaleString(i18n.language);

  useEffect(() => {
    let mounted = true;
    void run(() => commands.getHistoryThumbnail(item.id), true).then((url) => {
      if (mounted && url) setThumbnail(url);
    });
    return () => { mounted = false; };
  }, [item.id, run]);

  const copy = async () => {
    setCopied(false);
    const done = await run(() => commands.copyHistoryImage(item.id));
    setCopied(done !== undefined);
  };

  return (
    <li
      className={cn(
        'group flex flex-col gap-2 rounded-xl bg-card p-2 text-card-foreground shadow-soft transition-[transform,translate,box-shadow] duration-150 ease-enter hover:-translate-y-0.5 hover:shadow-soft-hover',
        selecting && 'cursor-pointer select-none',
        selected && 'ring-2 ring-foreground ring-offset-2 ring-offset-background',
        leaving && 'pointer-events-none animate-menu-out',
      )}
      onClick={selecting ? (event) => { onToggle(item.id, event.shiftKey); } : undefined}
    >
      <div className="relative flex aspect-[3/2] items-center justify-center overflow-hidden rounded-lg bg-canvas">
        {thumbnail && (
          <img
            src={thumbnail}
            alt={t('history.thumbnailAlt', { time: when })}
            className="max-h-full max-w-full object-contain"
          />
        )}
        <Checkbox
          checked={selected}
          aria-label={t('history.selectCapture', { time: when })}
          className={cn(
            'absolute top-2 left-2 transition-opacity duration-150 ease-enter',
            selecting
              ? 'opacity-100'
              : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
          )}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(item.id, event.shiftKey);
          }}
        />
      </div>
      <div className="flex flex-col px-1">
        <span className="text-control-sm">{when}</span>
        <span className="text-caption tabular-nums">
          {t('history.size', { width: item.width, height: item.height })}
        </span>
      </div>
      <div className={cn('flex flex-wrap gap-1.5 px-1 pb-1 opacity-0 transition-opacity duration-150 ease-enter group-focus-within:opacity-100 group-hover:opacity-100', selecting && 'hidden')}>
        <Button
          size="sm"
          onClick={() => { void run(() => commands.openHistoryInEditor(item.id)); }}
        >
          {t('history.openInEditor')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => { void copy(); }}>
          {t('history.copy')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { void run(() => commands.deleteHistoryImage(item.id)); }}
        >
          {t('history.delete')}
        </Button>
      </div>
      {copied && (
        <p role="status" className="text-caption px-1">
          {t('history.copied')}
        </p>
      )}
    </li>
  );
}
