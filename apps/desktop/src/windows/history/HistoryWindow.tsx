import { Button } from '@cropa/ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, events, type CommandError, type HistoryItem } from '../../lib/bindings.ts';
import { AppRail } from '../../features/shell/AppRail.tsx';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';

type Outcome<T> = { status: 'ok'; data: T } | { status: 'error'; error: CommandError };

export function HistoryWindow() {
  const { t } = useTranslation();
  const [items, setItems] = useState<HistoryItem[]>();
  const [saveHistory, setSaveHistory] = useState(true);
  const [error, setError] = useState<UserError>();
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);

  const reload = useCallback(() => {
    commands
      .listHistory()
      .then((result) => {
        if (result.status === 'ok') setItems(result.data);
        else setError(describeCommandError(t, result.error));
      })
      .catch((cause: unknown) => { setError(describeUnexpected(t, cause)); });
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
    void commands
      .getSettings()
      .then((settings) => { setSaveHistory(settings.saveHistory); })
      .catch((cause: unknown) => { setError(describeUnexpected(t, cause)); });
    const unlisten = events.historyChanged.listen(() => { reload(); });
    return () => {
      void unlisten.then((off) => { off(); });
    };
  }, [reload, t]);

  const deleteAll = async () => {
    setConfirmingDeleteAll(false);
    await run(() => commands.deleteAllHistory());
    reload();
  };

  const count = items?.length ?? 0;

  return (
    <div className="flex h-screen">
    <AppRail current="History" />
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <h1 className="text-heading">{t('history.title')}</h1>
        {items && items.length > 0 && (
          <span className="text-sm text-muted-foreground">{t('history.count', { total: count })}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {confirmingDeleteAll ? (
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
            <Button
              variant="outline"
              size="sm"
              disabled={count === 0}
              onClick={() => { setConfirmingDeleteAll(true); }}
            >
              {t('history.deleteAll')}
            </Button>
          )}
        </div>
      </header>

      <section className="flex-1 overflow-y-auto p-6">
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
              <HistoryCard key={item.id} item={item} run={run} />
            ))}
          </ul>
        )}
      </section>
    </main>
    </div>
  );
}

interface HistoryCardProps {
  item: HistoryItem;
  run: <T>(call: () => Promise<Outcome<T>>, keepNotice?: boolean) => Promise<T | undefined>;
}

function HistoryCard({ item, run }: HistoryCardProps) {
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
    <li className="group flex flex-col gap-2 rounded-xl border bg-card p-2 text-card-foreground">
      <div className="flex aspect-[3/2] items-center justify-center overflow-hidden rounded-lg bg-canvas">
        {thumbnail && (
          <img
            src={thumbnail}
            alt={t('history.thumbnailAlt', { time: when })}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>
      <div className="flex flex-col px-1">
        <span className="text-sm">{when}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('history.size', { width: item.width, height: item.height })}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 px-1 pb-1 opacity-0 transition-opacity duration-150 ease-enter group-focus-within:opacity-100 group-hover:opacity-100">
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
        <p role="status" className="px-1 text-xs text-muted-foreground">
          {t('history.copied')}
        </p>
      )}
    </li>
  );
}
