import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ShortcutField } from '../../features/settings/ShortcutField.tsx';
import {
  commands,
  events,
  type CommandError,
  type Settings,
  type ShortcutStatus,
  type ThemePreference,
} from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];

export function SettingsWindow() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Settings>();
  const [status, setStatus] = useState<ShortcutStatus>();
  // Read from Windows, not from settings.json: the user can change it in Task Manager.
  const [autostart, setAutostart] = useState<boolean>();
  const [error, setError] = useState<UserError>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([commands.getSettings(), commands.getShortcutStatus(), commands.getAutostart()])
      .then(([s, st, auto]) => {
        setSettings(s);
        setStatus(st);
        if (auto.status === 'ok') setAutostart(auto.data);
        else setError(describeCommandError(t, auto.error));
      })
      .catch((cause: unknown) => { setError(describeUnexpected(t, cause)); });
    const unlisten = events.shortcutStatus.listen((event) => { setStatus(event.payload); });
    return () => { void unlisten.then((off) => { off(); }); };
  }, [t]);

  /** Run a command that returns a typed Result, mapping errors to the 3-part notice. */
  const run = useCallback(
    async <T,>(
      call: () => Promise<{ status: 'ok'; data: T } | { status: 'error'; error: CommandError }>,
      vars: Record<string, string> = {},
    ): Promise<T | undefined> => {
      setBusy(true);
      setError(undefined);
      setSaved(false);
      try {
        const result = await call();
        if (result.status === 'error') {
          setError(describeCommandError(t, result.error, vars));
          return undefined;
        }
        setSaved(true);
        return result.data;
      } catch (cause) {
        setError(describeUnexpected(t, cause));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const changeShortcut = async (accelerator: string) => {
    const next = await run(() => commands.setCaptureShortcut(accelerator), { shortcut: accelerator });
    if (next) {
      setStatus(next);
      setSettings((s) => (s ? { ...s, captureShortcut: next.accelerator } : s));
    }
  };

  const changeTheme = async (value: ThemePreference) => {
    const next = await run(() => commands.setTheme(value));
    if (next) setSettings(next);
  };

  const changeAutostart = async (enabled: boolean) => {
    const next = await run(() => commands.setAutostart(enabled));
    if (next !== undefined) setAutostart(next);
  };

  // A shortcut that failed at startup is reported even before the user acts.
  const startupConflict =
    status && !status.registered && status.error && !error
      ? describeCommandError(
          t,
          { kind: status.error === 'InUse' ? 'ShortcutInUse' : 'ShortcutInvalid' },
          { shortcut: status.accelerator },
        )
      : undefined;
  const notice = error ?? startupConflict;

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('settings.title')}</h1>

      {notice && <ErrorNotice error={notice} />}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t('settings.shortcut.label')}</span>
          {status && (
            <span
              className={
                status.registered ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'
              }
            >
              {status.registered
                ? t('settings.shortcut.registered')
                : t('settings.shortcut.notRegistered')}
            </span>
          )}
        </div>
        <ShortcutField
          value={status?.accelerator ?? settings?.captureShortcut ?? ''}
          disabled={busy || !settings}
          onChange={(accelerator) => { void changeShortcut(accelerator); }}
        />
        <p className="text-xs text-muted-foreground">{t('settings.shortcut.description')}</p>
      </section>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('settings.theme.label')}</legend>
        <div className="inline-flex w-fit gap-0.5 rounded-md border bg-muted p-0.5">
          {THEMES.map((value) => (
            <label
              key={value}
              className="inline-flex h-7 cursor-pointer items-center rounded-sm px-3 text-sm not-has-[:checked]:hover:bg-accent has-[:checked]:bg-selected has-[:checked]:text-selected-foreground has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50"
            >
              <input
                type="radio"
                name="theme"
                value={value}
                className="sr-only"
                checked={settings?.theme === value}
                // Not disabled while saving: arrow keys move through the group,
                // and disabling the focused radio would drop the focus.
                disabled={!settings}
                onChange={() => { void changeTheme(value); }}
              />
              {t(`settings.theme.${value}`)}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.theme.description')}</p>
      </fieldset>

      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={autostart ?? false}
          disabled={busy || autostart === undefined}
          onChange={(event) => { void changeAutostart(event.target.checked); }}
        />
        {t('settings.autostart.label')}
      </label>

      {saved && !notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('settings.saved')}
        </p>
      )}
    </main>
  );
}
