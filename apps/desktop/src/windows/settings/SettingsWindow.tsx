import {
  Button,
  CameraIcon,
  InfoIcon,
  PaletteIcon,
  SegmentedControl,
  SegmentedControlItem,
  SidebarNav,
  SparklesIcon,
  Switch,
  TuningIcon,
} from '@cropa/ui';
import { getVersion } from '@tauri-apps/api/app';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { AiSettingsSection } from '../../features/ai/AiSettingsSection.tsx';
import {
  SETTINGS_SECTIONS,
  selectSettingsSection,
  useSettingsSection,
  type SettingsSectionId,
} from '../../features/settings/sections.ts';
import { SettingRow, SettingsSection } from '../../features/settings/SettingsLayout.tsx';
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

const SECTION_ICONS: Record<SettingsSectionId, ReactNode> = {
  capture: <CameraIcon />,
  appearance: <PaletteIcon />,
  general: <TuningIcon />,
  ai: <SparklesIcon />,
  about: <InfoIcon />,
};

interface RunOptions {
  /** Clear the current notice before the call (default). */
  resetError?: boolean;
  /** A retry the user did not start: it only touches the notice for a PrtScn refusal or success. */
  automatic?: boolean;
  /** The page a failure is shown on; by default the page that is open. */
  page?: SettingsSectionId;
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
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // PrtScn was chosen but Windows or another app still holds the key.
  const [printScreenRefused, setPrintScreenRefused] = useState(false);
  // Guards against stacking automatic retries on top of a running command.
  const busyRef = useRef(false);
  // The user picked another shortcut after PrtScn was refused: stop retrying PrtScn.
  const [printScreenAbandoned, setPrintScreenAbandoned] = useState(false);

  const section = useSettingsSection();
  // A later page enters from below, an earlier one from above.
  const [shownSection, setShownSection] = useState(section);
  const [direction, setDirection] = useState(1);
  // Whether a page entering animates: only after one is picked inside the view.
  const [pageMoves, setPageMoves] = useState(false);
  if (shownSection !== section) {
    setDirection(SETTINGS_SECTIONS.indexOf(section) > SETTINGS_SECTIONS.indexOf(shownSection) ? 1 : -1);
    setShownSection(section);
    // The confirmation belongs to the page where the user acted.
    setSaved(false);
    setPageMoves(true);
  }
  // When the whole view slides in, the page comes with it instead of moving on its own. Checked
  // after the page change, so Help > About, which does both at once, only slides the view.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (active) setPageMoves(false);
  }
  const sectionRef = useRef(section);
  useLayoutEffect(() => {
    sectionRef.current = section;
  }, [section]);

  // A notice shows on the page it is about: a failed load on every page, a failed action on the
  // page where the user acted.
  const [failure, setFailure] = useState<{ error: UserError; page: SettingsSectionId | 'all' }>();
  const setError = useCallback(
    (next: UserError | undefined, page: SettingsSectionId | 'all' = sectionRef.current) => {
      setFailure(next && { error: next, page });
    },
    [],
  );
  const error =
    failure && (failure.page === 'all' || failure.page === section) ? failure.error : undefined;
  // A new page starts at its top, not where the last one was scrolled to.
  const contentRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  useEffect(() => {
    Promise.all([commands.getSettings(), commands.getShortcutStatus(), commands.getAutostart()])
      .then(([s, st, auto]) => {
        setSettings(s);
        setStatus(st);
        if (auto.status === 'ok') setAutostart(auto.data);
        else setError(describeCommandError(t, auto.error), 'all');
      })
      .catch((cause: unknown) => { setError(describeUnexpected(t, cause), 'all'); });
    const unlistenStatus = events.shortcutStatus.listen((event) => { setStatus(event.payload); });
    // The first-launch question can be answered while this window is open.
    const unlistenAutostart = events.autostartChanged.listen((event) => {
      setAutostart(event.payload.enabled);
    });
    return () => {
      void unlistenStatus.then((off) => { off(); });
      void unlistenAutostart.then((off) => { off(); });
    };
  }, [t, setError]);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((cause: unknown) => { setError(describeUnexpected(t, cause), 'all'); });
  }, [t, setError]);

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
      { resetError = true, automatic = false, onError, page }: RunOptions = {},
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
            setError(describeCommandError(t, result.error, vars), page);
          }
          return undefined;
        }
        if (automatic) setError(undefined);
        setSaved(true);
        return result.data;
      } catch (cause) {
        if (!automatic) setError(describeUnexpected(t, cause), page);
        return undefined;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [t, setError],
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
        // A retry runs when the window regains the focus, whatever page is open.
        page: 'capture',
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

  // A shortcut that failed at startup is reported even before the user acts, on the page that fixes it.
  const startupConflict =
    section === 'capture' && status && !status.registered && status.error && !error
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

  const sectionLabels: Record<SettingsSectionId, string> = {
    capture: t('settings.sections.capture'),
    appearance: t('settings.sections.appearance'),
    general: t('settings.sections.general'),
    ai: t('ai.settings.title'),
    about: t('settings.about.title'),
  };
  const navItems = SETTINGS_SECTIONS.map((id) => ({
    value: id,
    label: sectionLabels[id],
    icon: SECTION_ICONS[id],
  }));
  const slideFrom = {
    '--section-from': `calc(var(--motion-slide) * ${String(direction)})`,
  } as CSSProperties;
  // Every page stays mounted, so a test running in the AI page survives a visit to another page.
  const page = (id: SettingsSectionId, children: ReactNode) => (
    <div
      hidden={section !== id}
      style={pageMoves ? slideFrom : undefined}
      className={pageMoves ? 'animate-section-in' : undefined}
    >
      {children}
    </div>
  );

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex w-[216px] shrink-0 flex-col gap-6 overflow-y-auto px-4 py-10">
        <h1 className="text-title truncate px-2.5">{t('settings.title')}</h1>
        <SidebarNav
          aria-label={t('settings.nav')}
          items={navItems}
          value={section}
          onValueChange={(next) => { selectSettingsSection(next as SettingsSectionId); }}
        />
      </div>

      <main ref={contentRef} className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[680px] flex-col gap-6 py-10 pr-8 pl-4">
          <div className="flex h-9 items-center justify-end">
            {saved && !notice && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('settings.saved')}
              </p>
            )}
          </div>

          {notice && <ErrorNotice error={notice} />}

          {page(
            'capture',
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
            </SettingsSection>,
          )}

          {page(
            'appearance',
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
            </SettingsSection>,
          )}

          {page(
            'general',
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
            </SettingsSection>,
          )}

          {page('ai', <AiSettingsSection settings={settings} onSettings={setSettings} />)}

          {page(
            'about',
            <SettingsSection title={t('settings.about.title')}>
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
            </SettingsSection>,
          )}
        </div>
      </main>
    </div>
  );
}
