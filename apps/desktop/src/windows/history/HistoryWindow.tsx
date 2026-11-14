import {
  Button,
  CheckCircleIcon,
  cn,
  DeleteIcon,
  InfoIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@cropa/ui';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { selectSettingsSection } from '../../features/settings/sections.ts';
import { requestCaptureAfterPaint } from '../../features/shell/capture.ts';
import { useShowView, useViewActive } from '../../features/shell/view-active.ts';
import { commands, events, type HistoryItem } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';
import { HistoryCard, type Outcome } from './HistoryCard.tsx';
import { HistoryEmpty } from './HistoryEmpty.tsx';
import { describeDay, groupByDay, type DayGroup } from './history-days.ts';
import { selectRange, toggleId } from './history-selection.ts';

/** Matches the 140 ms exit animation, plus a frame. */
const LEAVE_MS = 150;

/** How long the selection bar's fade-out gets before it is removed even if no animation event arrives. */
const BAR_EXIT_MS = 220;

const NONE: ReadonlySet<string> = new Set();

function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

function capitalise(label: string, lang: string): string {
  return label.charAt(0).toLocaleUpperCase(lang) + label.slice(1);
}

export function HistoryView() {
  const active = useViewActive();
  const showView = useShowView();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const baseId = useId();
  const [items, setItems] = useState<HistoryItem[]>();
  const [saveHistory, setSaveHistory] = useState(true);
  const [captureShortcut, setCaptureShortcut] = useState<string>();
  const [wasActive, setWasActive] = useState(active);
  const [error, setError] = useState<UserError>();
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(NONE);
  const [anchor, setAnchor] = useState<string>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(NONE);
  const [scrolled, setScrolled] = useState(false);
  const [barShown, setBarShown] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);
  const selectButton = useRef<HTMLButtonElement>(null);
  const selectAllButton = useRef<HTMLButtonElement>(null);
  const barDelete = useRef<HTMLButtonElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const cancelDeleteAll = useRef<HTMLButtonElement>(null);
  const focusBarOnEnter = useRef(false);
  const focusSelectOnLeave = useRef(false);
  const focusBarDeleteOnClose = useRef(false);
  const deletingOne = useRef(new Set<string>());
  // Where focus goes once the list has reloaded: the neighbour of a deleted capture, or the empty
  // state's button when `whenEmpty` is set and nothing is left.
  const pendingFocus = useRef<{ deleted?: string; next?: string | undefined; whenEmpty?: boolean }>(undefined);
  const confirmAllTitleId = `${baseId}-confirm-all-title`;
  const confirmAllCaptionId = `${baseId}-confirm-all-caption`;
  const confirmQuestionId = `${baseId}-confirm-question`;

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
      .finally(() => {
        setLeaving(deletingOne.current.size > 0 ? new Set(deletingOne.current) : NONE);
      });
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
    // The hint names the shortcut only while it is actually registered.
    void commands
      .getShortcutStatus()
      .then((status) => { setCaptureShortcut(status.registered ? status.accelerator : undefined); })
      .catch((cause: unknown) => { setError(describeUnexpected(t, cause)); });
  }, [active, t]);

  // A confirmation does not outlive the view being on screen.
  if (active !== wasActive) {
    setWasActive(active);
    if (!active) {
      setConfirmingDeleteAll(false);
      setConfirmingDelete(false);
    }
  }

  // A hairline under the header once the list has scrolled beneath it.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onScroll = () => { setScrolled(element.scrollTop > 0); };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => { element.removeEventListener('scroll', onScroll); };
  }, []);

  const groups = useMemo(() => groupByDay(items ?? []), [items]);
  // In display order, so a range always matches what is on screen.
  const ids = useMemo(() => groups.flatMap((group) => group.items.map((item) => item.id)), [groups]);
  const count = items?.length ?? 0;
  const allSelected = count > 0 && selected.size === count;

  const deleteAll = async () => {
    setConfirmingDeleteAll(false);
    await run(() => commands.deleteAllHistory());
    pendingFocus.current = { whenEmpty: true };
    reload();
  };

  const leaveSelecting = useCallback(() => {
    const focused = document.activeElement;
    if (focused === document.body || (focused !== null && bar.current?.contains(focused))) {
      focusSelectOnLeave.current = true;
    }
    setSelecting(false);
    setConfirmingDelete(false);
    setSelected(NONE);
    setAnchor(undefined);
  }, []);

  const enterSelecting = (fromButton: boolean) => {
    if (!selecting && fromButton) focusBarOnEnter.current = true;
    setSelecting(true);
    setConfirmingDeleteAll(false);
  };

  const toggle = (id: string, shiftKey: boolean) => {
    enterSelecting(false);
    setSelected(shiftKey ? selectRange(selected, ids, anchor, id) : toggleId(selected, id));
    if (!shiftKey) setAnchor(id);
  };

  const selectAll = () => {
    enterSelecting(false);
    setSelected(new Set(ids));
  };

  const closeConfirm = useCallback(() => {
    focusBarDeleteOnClose.current = true;
    setConfirmingDelete(false);
  }, []);

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
      if (chosen.length === ids.length) {
        // Nothing may be left: the empty state's button takes focus instead of the Select button.
        focusSelectOnLeave.current = false;
        pendingFocus.current = { whenEmpty: true };
      }
      reload();
    }
  };

  const deleteOne = async (id: string) => {
    if (deletingOne.current.has(id)) return;
    deletingOne.current.add(id);
    const at = ids.indexOf(id);
    const focused = document.activeElement;
    // Only a keyboard user's focus is carried on; a mouse click leaves nothing to restore.
    if (
      focused instanceof HTMLElement &&
      focused.matches(':focus-visible') &&
      focused.closest('[data-history-id]')?.getAttribute('data-history-id') === id
    ) {
      pendingFocus.current = { deleted: id, next: ids[at + 1] ?? (at > 0 ? ids[at - 1] : undefined) };
    }
    setLeaving((current) => new Set(current).add(id));
    try {
      await new Promise((resolve) => setTimeout(resolve, LEAVE_MS));
      await run(() => commands.deleteHistoryImage(id));
    } finally {
      deletingOne.current.delete(id);
      reload();
    }
  };

  const openSettings = () => {
    // The history switch is on the General page.
    selectSettingsSection('general');
    showView('Settings');
  };

  const captureRegion = () => {
    requestCaptureAfterPaint().catch((cause: unknown) => { setError(describeUnexpected(t, cause)); });
  };

  // The selection bar stays mounted while it fades out.
  if (selecting && !barShown) setBarShown(true);
  useEffect(() => {
    if (selecting) return;
    const timer = window.setTimeout(() => { setBarShown(false); }, BAR_EXIT_MS);
    return () => { window.clearTimeout(timer); };
  }, [selecting]);

  // Focus follows the mode: into the bar when the Select button opened it, back to that button when it closes.
  useEffect(() => {
    if (selecting && focusBarOnEnter.current) {
      focusBarOnEnter.current = false;
      selectAllButton.current?.focus();
    } else if (!selecting && focusSelectOnLeave.current) {
      focusSelectOnLeave.current = false;
      selectButton.current?.focus();
    }
  }, [selecting]);

  useEffect(() => {
    if (confirmingDelete) cancelDelete.current?.focus();
    else if (focusBarDeleteOnClose.current) {
      focusBarDeleteOnClose.current = false;
      barDelete.current?.focus();
    }
  }, [confirmingDelete]);

  // After a single delete, focus moves to the neighbour (or the empty state's button) so keyboard use carries on.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || !items) return;
    pendingFocus.current = undefined;
    // The capture is still listed: the delete failed, so there is nothing to move focus away from.
    if (pending.deleted !== undefined && items.some((item) => item.id === pending.deleted)) return;
    // Some captures could not be deleted, so the list is not empty: the header's Select button takes focus.
    if (pending.whenEmpty && items.length > 0) {
      selectButton.current?.focus();
      return;
    }
    const selector =
      pending.next === undefined
        ? '[data-history-primary]'
        : `[data-history-id="${CSS.escape(pending.next)}"] button[data-history-open]`;
    scroller.current?.querySelector<HTMLElement>(selector)?.focus();
  }, [items]);

  // Keyboard shortcuts only while this view is in front: the views stay mounted.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (confirmingDelete) closeConfirm();
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
        setSelected(new Set(ids));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [active, confirmingDelete, selecting, count, ids, leaveSelecting, closeConfirm]);

  const now = new Date();
  const dayLabel = (group: DayGroup): string => {
    if (!group.day) return t('history.unknownDay');
    const kind = describeDay(group.day, now);
    if (kind === 'today') return t('history.today');
    if (kind === 'yesterday') return t('history.yesterday');
    const options: Intl.DateTimeFormatOptions =
      kind === 'thisWeek'
        ? { weekday: 'long' }
        : kind === 'thisYear'
          ? { weekday: 'long', day: 'numeric', month: 'long' }
          : { day: 'numeric', month: 'long', year: 'numeric' };
    return capitalise(new Intl.DateTimeFormat(lang, options).format(group.day), lang);
  };
  const timeFormat = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' });

  const barExiting = !selecting;

  return (
    <main className="relative flex min-w-0 flex-1 flex-col">
      <header
        className={cn(
          'flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-8 pt-7 pb-4 transition-colors duration-150',
          scrolled ? 'border-border' : 'border-transparent',
        )}
      >
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-title truncate">{t('history.title')}</h1>
          {count > 0 && (
            <span className="rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-tiny tabular-nums text-muted-foreground">
              {t('history.captureCount', { count })}
            </span>
          )}
        </div>
        {selecting ? (
          <p className="text-caption ml-auto max-w-[50%] min-w-0 truncate">{t('history.selectHint')}</p>
        ) : (
          <div className="ml-auto flex items-center gap-2">
            <Button
              ref={selectButton}
              variant="secondary"
              size="sm"
              disabled={count === 0}
              onClick={() => { enterSelecting(true); }}
            >
              <CheckCircleIcon />
              {t('history.select')}
            </Button>
            <Popover open={confirmingDeleteAll} onOpenChange={setConfirmingDeleteAll} modal>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="hover:text-destructive" disabled={count === 0}>
                  <DeleteIcon />
                  {t('history.deleteAll')}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                sideOffset={8}
                className="w-[300px] animate-confirm-in rounded-[20px] p-5 data-[state=closed]:animate-confirm-out"
                aria-labelledby={confirmAllTitleId}
                aria-describedby={confirmAllCaptionId}
                onOpenAutoFocus={(event) => {
                  event.preventDefault();
                  cancelDeleteAll.current?.focus();
                }}
              >
                <p id={confirmAllTitleId} className="text-heading">{t('history.confirmAll.title')}</p>
                <p id={confirmAllCaptionId} className="mt-1 text-[12.5px] leading-snug text-muted-foreground">
                  {t('history.confirmAll.caption', { count })}
                </p>
                <div className="mt-4 flex gap-2">
                  <Button
                    ref={cancelDeleteAll}
                    variant="secondary"
                    className="h-9 flex-1 rounded-full"
                    onClick={() => { setConfirmingDeleteAll(false); }}
                  >
                    {t('history.confirm.cancel')}
                  </Button>
                  <Button
                    variant="destructive"
                    className="h-9 flex-1 rounded-full"
                    onClick={() => { void deleteAll(); }}
                  >
                    {t('history.deleteAll')}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        )}
      </header>

      <div ref={scroller} className={cn('min-h-0 flex-1 overflow-y-auto px-8 pb-8', selecting && 'pb-28')}>
        {error && (
          <div className="mt-6 mb-6">
            <ErrorNotice error={error} />
          </div>
        )}
        {!saveHistory && count > 0 && (
          <div className="mt-6 mb-6 flex items-center gap-3 rounded-xl bg-foreground/[0.04] px-4 py-3">
            <InfoIcon className="size-[18px] shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 text-control-sm font-normal text-muted-foreground">
              {t('history.offBanner')}
            </p>
            <Button variant="secondary" size="sm" onClick={openSettings}>
              {t('history.openSettings')}
            </Button>
          </div>
        )}
        {items?.length === 0 && (
          <HistoryEmpty
            kind={saveHistory ? 'empty' : 'off'}
            shortcut={captureShortcut}
            onCapture={captureRegion}
            onOpenSettings={openSettings}
          />
        )}
        {items && items.length > 0 && (
          <div className="flex flex-col gap-7">
            {groups.map((group) => {
              const headingId = `${baseId}-${group.key}`;
              return (
                <section key={group.key} aria-labelledby={headingId}>
                  <h2
                    id={headingId}
                    className="sticky top-0 z-10 -mx-8 flex items-baseline gap-2 bg-panel/90 px-8 pt-3 pb-3 text-[13px] font-semibold tracking-[-0.2px] backdrop-blur-md"
                  >
                    {dayLabel(group)}
                    <span aria-hidden="true" className="text-caption font-normal tabular-nums">
                      {group.items.length}
                    </span>
                  </h2>
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(208px,1fr))] gap-x-5 gap-y-6">
                    {group.items.map((item) => {
                      const at = item.capturedAt === null ? undefined : new Date(item.capturedAt);
                      return (
                        <HistoryCard
                          key={item.id}
                          item={item}
                          when={at ? at.toLocaleString(lang) : t('history.unknownTime')}
                          time={at ? timeFormat.format(at) : t('history.unknownTime')}
                          run={run}
                          selecting={selecting}
                          selected={selected.has(item.id)}
                          leaving={leaving.has(item.id)}
                          onToggle={toggle}
                          onDelete={(id) => { void deleteOne(id); }}
                        />
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {(selecting || barShown) && (
        <section
          ref={bar}
          aria-label={t('history.selectionBar')}
          className={cn(
            'absolute bottom-6 left-1/2 z-20 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-1 rounded-[22px] bg-popover py-1.5 pr-1.5 pl-4 text-popover-foreground shadow-menu',
            barExiting ? 'pointer-events-none animate-fade-out' : 'animate-notice-in',
          )}
          onAnimationEnd={(event) => {
            if (barExiting && event.target === event.currentTarget) setBarShown(false);
          }}
        >
          {confirmingDelete ? (
            <div
              key="confirm"
              role="group"
              aria-labelledby={confirmQuestionId}
              className="flex min-w-0 animate-fade-in items-center gap-1"
            >
              <p id={confirmQuestionId} className="mr-2 min-w-0 text-control-sm font-normal">
                {t('history.confirm.deleteSelected', { count: selected.size })}
              </p>
              <Button
                ref={cancelDelete}
                aria-describedby={confirmQuestionId}
                variant="secondary"
                size="sm"
                className="rounded-full"
                onClick={closeConfirm}
              >
                {t('history.confirm.cancel')}
              </Button>
              <Button
                aria-describedby={confirmQuestionId}
                variant="destructive"
                size="sm"
                className="rounded-full"
                onClick={() => { void deleteSelected(); }}
              >
                {t('history.delete')}
              </Button>
            </div>
          ) : (
            <div key="actions" className="flex animate-fade-in items-center gap-1">
              <span aria-live="polite" className="mr-2 text-control-sm whitespace-nowrap tabular-nums">
                {t('history.selectedCount', { count: selected.size })}
              </span>
              <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
              <Button
                ref={selectAllButton}
                variant="ghost"
                size="sm"
                className="rounded-full"
                onClick={allSelected ? () => { setSelected(NONE); setAnchor(undefined); } : selectAll}
              >
                {allSelected ? t('history.clearSelection') : t('history.selectAll')}
              </Button>
              <Button
                ref={barDelete}
                variant="destructive"
                size="sm"
                className="rounded-full"
                disabled={selected.size === 0}
                onClick={() => { setConfirmingDelete(true); }}
              >
                <DeleteIcon />
                {t('history.delete')}
              </Button>
              <Button variant="secondary" size="sm" className="rounded-full" onClick={leaveSelecting}>
                {t('history.done')}
              </Button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
