import { Button } from '@cropa/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ShortcutField } from '../../features/settings/ShortcutField.tsx';
import {
  commands,
  events,
  type CommandError,
  type Settings,
  type ShortcutErrorKind,
  type ShortcutStatus,
  type ThemePreference,
} from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';

const PRINT_SCREEN = 'PrintScreen';
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];

interface RunOptions {
  /** Clear the current notice before the call (default). */
  resetError?: boolean;
  /** A retry the user did not start: it only touches the notice for a PrtScn refusal or success. */
  automatic?: boolean;
  onError?: (error: CommandError) => void;
}

function startupErrorKind(
  error: ShortcutErrorKind,
): 'ShortcutInUse' | 'ShortcutInvalid' | 'PrintScreenInUse' {
  switch (error) {
    case 'InUse':
      return 'ShortcutInUse';
    case 'Invalid':
      return 'ShortcutInvalid';
    case 'PrintScreenInUse':
      return 'PrintScreenInUse';
  }
}

export function SettingsWindow() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Settings>();
  const [status, setStatus] = useState<ShortcutStatus>();
  // Read from Windows, not from settings.json: the user can change it in Task Manager.
  const [autostart, setAutostart] = useState<boolean>();
  const [error, setError] = useState<UserError>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // PrtScn was chosen but Windows or another app still holds the key.
  const [printScreenRefused, setPrintScreenRefused] = useState(false);
  // Guards against stacking automatic retries on top of a running command.
  const busyRef = useRef(false);
  // The user picked another shortcut after PrtScn was refused: stop retrying PrtScn.
  const [printScreenAbandoned, setPrintScreenAbandoned] = useState(false);

  useEffect(() => {
    Promise.all([commands.getSettings(), commands.getShortcutStatus(), commands.getAutostart()])
      .then(([s, st, auto]) => {
        setSettings(s);
        setStatus(st);
        if (auto.status === 'ok') setAutostart(auto.data);
        else setError(describeCommandError(t, auto.error));
      })
      .catch((cause: unknown) => { setError(describeUnexpected(t, cause)); });
    const unlistenStatus = events.shortcutStatus.listen((event) => { setStatus(event.payload); });
    // The first-launch question can be answered while this window is open.
    const unlistenAutostart = events.autostartChanged.listen((event) => {
      setAutostart(event.payload.enabled);
    });
    return () => {
      void unlistenStatus.then((off) => { off(); });
      void unlistenAutostart.then((off) => { off(); });
    };
  }, [t]);

  /** Run a command that returns a typed Result, mapping errors to the 3-part notice. */
  const run = useCallback(
    async <T,>(
      call: () => Promise<{ status: 'ok'; data: T } | { status: 'error'; error: CommandError }>,
      vars: Record<string, string> = {},
      { resetError = true, automatic = false, onError }: RunOptions = {},
    ): Promise<T | undefined> => {
      busyRef.current = true;
      setBusy(true);
      if (resetError && !automatic) setError(undefined);
      setSaved(false);
      try {
        const result = await call();
        if (result.status === 'error') {
          onError?.(result.error);
          // An automatic retry must not replace a notice the user is reading.
          if (!automatic || result.error.kind === 'PrintScreenInUse') {
            setError(describeCommandError(t, result.error, vars));
          }
          return undefined;
        }
        if (automatic) setError(undefined);
        setSaved(true);
        return result.data;
      } catch (cause) {
        if (!automatic) setError(describeUnexpected(t, cause));
        return undefined;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [t],
  );

  const changeShortcut = async (accelerator: string) => {
    setPrintScreenRefused(false);
    setPrintScreenAbandoned(true);
    const next = await run(() => commands.setCaptureShortcut(accelerator), { shortcut: accelerator });
    if (next) {
      setStatus(next);
      setSettings((s) => (s ? { ...s, captureShortcut: next.accelerator } : s));
    }
  };

  const openPrintScreenSetting = () => run(() => commands.openPrintScreenSetting());

  /** Register PrtScn; on a refusal keep waiting for the user to free the key. */
  const registerPrintScreen = useCallback(
    async (mode: 'user' | 'chained' | 'automatic') => {
      if (mode !== 'automatic') setPrintScreenAbandoned(false);
      const outcome = { refused: false };
      const next = await run(() => commands.setCaptureShortcut(PRINT_SCREEN), {}, {
        resetError: mode === 'user',
        automatic: mode === 'automatic',
        onError: (e) => { outcome.refused = e.kind === 'PrintScreenInUse'; },
      });
      if (next) {
        setStatus(next);
        setSettings((s) => (s ? { ...s, captureShortcut: next.accelerator } : s));
        setPrintScreenRefused(false);
      } else if (outcome.refused) {
        setPrintScreenRefused(true);
      } else if (mode !== 'automatic') {
        setPrintScreenRefused(false);
      }
    },
    [run],
  );

  const choosePrintScreen = async () => {
    await openPrintScreenSetting();
    // A registration error replaces an error from opening the setting.
    await registerPrintScreen('chained');
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
      ? describeCommandError(t, { kind: startupErrorKind(status.error) }, { shortcut: status.accelerator })
      : undefined;
  const notice = error ?? startupConflict;
  const waitingForPrintScreen =
    !printScreenAbandoned &&
    (printScreenRefused ||
      (status?.accelerator === PRINT_SCREEN &&
        !status.registered &&
        status.error === 'PrintScreenInUse'));
  const printScreenActive = status?.accelerator === PRINT_SCREEN && status.registered;

  // The user comes back from Windows Settings: try the key again on its own.
  useEffect(() => {
    if (!waitingForPrintScreen) return;
    const retry = () => {
      if (!busyRef.current) void registerPrintScreen('automatic');
    };
    window.addEventListener('focus', retry);
    return () => { window.removeEventListener('focus', retry); };
  }, [waitingForPrintScreen, registerPrintScreen]);

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{t('settings.title')}</h1>

      {notice && <ErrorNotice error={notice} />}

      {waitingForPrintScreen && (
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => { void registerPrintScreen('user'); }}
          >
            {t('settings.printScreen.retry')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => { void openPrintScreenSetting(); }}
          >
            {t('settings.printScreen.openSetting')}
          </Button>
        </div>
      )}

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
        {!printScreenActive && (
          <div className="flex flex-col items-start gap-1">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !settings}
              onClick={() => { void choosePrintScreen(); }}
            >
              {t('settings.shortcut.usePrintScreen')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('settings.shortcut.printScreenHint')}</p>
          </div>
        )}
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
