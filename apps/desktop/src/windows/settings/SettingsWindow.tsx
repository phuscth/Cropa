import { Button, SegmentedControl, SegmentedControlItem, Switch } from '@cropa/ui';
import { getVersion } from '@tauri-apps/api/app';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AiSettingsSection } from '../../features/ai/AiSettingsSection.tsx';
import { ABOUT_SECTION_ID, SettingRow, SettingsSection } from '../../features/settings/SettingsLayout.tsx';
import { useViewActive } from '../../features/shell/view-active.ts';
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

export function SettingsView() {
  const active = useViewActive();
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Settings>();
  const [status, setStatus] = useState<ShortcutStatus>();
  // Read from Windows, not from settings.json: the user can change it in Task Manager.
  const [autostart, setAutostart] = useState<boolean>();
  const [version, setVersion] = useState<string>();
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

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((cause: unknown) => { setError(describeUnexpected(t, cause)); });
  }, [t]);

  // The save folder can change from the editor, so read the settings again when
  // this view comes to the front and when the window regains the focus.
  const shown = useRef(false);
  useEffect(() => {
    const reload = () => {
      commands.getSettings().then(setSettings).catch(() => undefined);
    };
    // The mount effect above already read them the first time.
    if (active && shown.current) reload();
    shown.current = true;
    window.addEventListener('focus', reload);
    return () => { window.removeEventListener('focus', reload); };
  }, [active]);

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

  const changeSaveHistory = async (enabled: boolean) => {
    const next = await run(() => commands.setSaveHistory(enabled));
    if (next) setSettings(next);
  };

  const changeClipboardPrivacy = async (enabled: boolean) => {
    const next = await run(() => commands.setExcludeFromClipboardHistory(enabled));
    if (next) setSettings(next);
  };

  const changeSaveFolder = async () => {
    const next = await run(() => commands.chooseSaveFolder());
    if (next) setSettings(next);
  };

  const resetSaveFolder = async () => {
    const next = await run(() => commands.resetSaveFolder());
    if (next) setSettings(next);
  };

  const openSponsorsPage = () => run(() => commands.openSponsorsPage());

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
    <main className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[680px] flex-col gap-8 px-8 py-10">
        <header className="flex items-baseline justify-between gap-4">
          <h1 className="text-title">{t('settings.title')}</h1>
          {saved && !notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('settings.saved')}
            </p>
          )}
        </header>

        {notice && <ErrorNotice error={notice} />}

        <SettingsSection title={t('settings.sections.capture')}>
          <SettingRow
            stacked
            label={t('settings.shortcut.label')}
            description={t('settings.shortcut.description')}
            aside={
              status && (
                <span
                  className={
                    status.registered
                      ? 'text-xs text-muted-foreground'
                      : 'text-xs text-destructive'
                  }
                >
                  {status.registered
                    ? t('settings.shortcut.registered')
                    : t('settings.shortcut.notRegistered')}
                </span>
              )
            }
          >
            <div className="flex flex-col gap-3">
              <ShortcutField
                value={status?.accelerator ?? settings?.captureShortcut ?? ''}
                disabled={busy || !settings}
                onChange={(accelerator) => { void changeShortcut(accelerator); }}
              />
              {waitingForPrintScreen && (
                <div className="flex flex-wrap gap-2">
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
              {!printScreenActive && (
                <div className="flex flex-col items-start gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || !settings}
                    onClick={() => { void choosePrintScreen(); }}
                  >
                    {t('settings.shortcut.usePrintScreen')}
                  </Button>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.shortcut.printScreenHint')}
                  </p>
                </div>
              )}
            </div>
          </SettingRow>

          <SettingRow
            label={t('settings.saveFolder.label')}
            description={settings?.saveFolder ?? t('settings.saveFolder.notSet')}
          >
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !settings}
              onClick={() => { void changeSaveFolder(); }}
            >
              {t('settings.saveFolder.change')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !settings?.saveFolder}
              onClick={() => { void resetSaveFolder(); }}
            >
              {t('settings.saveFolder.reset')}
            </Button>
          </SettingRow>
        </SettingsSection>

        <SettingsSection title={t('settings.sections.appearance')}>
          <SettingRow
            label={t('settings.theme.label')}
            description={t('settings.theme.description')}
          >
            {({ labelId }) => (
              <SegmentedControl
                aria-labelledby={labelId}
                className="w-auto"
                value={settings?.theme}
                // Not disabled while saving: arrow keys move through the group,
                // and disabling the focused item would drop the focus.
                disabled={!settings}
                onValueChange={(value) => { void changeTheme(value as ThemePreference); }}
              >
                {THEMES.map((value) => (
                  <SegmentedControlItem key={value} value={value}>
                    {t(`settings.theme.${value}`)}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            )}
          </SettingRow>
        </SettingsSection>

        <SettingsSection title={t('settings.sections.general')}>
          <SettingRow label={t('settings.autostart.label')}>
            {({ labelId }) => (
              <Switch
                aria-labelledby={labelId}
                checked={autostart ?? false}
                disabled={busy || autostart === undefined}
                onCheckedChange={(enabled) => { void changeAutostart(enabled); }}
              />
            )}
          </SettingRow>
          <SettingRow
            label={t('settings.history.label')}
            description={t('settings.history.description')}
          >
            {({ labelId, descriptionId }) => (
              <Switch
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                checked={settings?.saveHistory ?? true}
                disabled={busy || !settings}
                onCheckedChange={(enabled) => { void changeSaveHistory(enabled); }}
              />
            )}
          </SettingRow>
          <SettingRow
            label={t('settings.clipboardPrivacy.label')}
            description={t('settings.clipboardPrivacy.description')}
          >
            {({ labelId, descriptionId }) => (
              <Switch
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                checked={settings?.excludeFromClipboardHistory ?? false}
                disabled={busy || !settings}
                onCheckedChange={(enabled) => { void changeClipboardPrivacy(enabled); }}
              />
            )}
          </SettingRow>
        </SettingsSection>

        <AiSettingsSection settings={settings} onSettings={setSettings} />

        <SettingsSection id={ABOUT_SECTION_ID} title={t('settings.about.title')}>
          <SettingRow
            label={version ? t('settings.about.version', { version }) : t('app.name')}
            description={t('settings.about.iconCredit')}
          >
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => { void openSponsorsPage(); }}
            >
              {t('settings.about.sponsor')}
            </Button>
          </SettingRow>
        </SettingsSection>
      </div>
    </main>
  );
}
