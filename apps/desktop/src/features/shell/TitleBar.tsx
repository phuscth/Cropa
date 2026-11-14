import {
  Button,
  CopyIcon,
  DragOutIcon,
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
  Popover,
  PopoverTrigger,
  RedoIcon,
  SaveIcon,
  UndoIcon,
  cn,
} from '@cropa/ui';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, events, type MainView, type ThemePreference } from '../../lib/bindings.ts';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';
import { requestCaptureAfterPaint } from './capture.ts';
import { useEditorActions } from './editor-actions.ts';
import { SavePopover } from './SavePopover.tsx';

interface Props {
  /** The view on screen. */
  view: MainView;
  onView: (view: MainView) => void;
  /** Shows the About card of the settings view. */
  onAbout: () => void;
  /** Reports a failed command or window call to the shell's notice. */
  onError: (error: UserError) => void;
  /** The theme was changed here, so other views showing it should read it again. */
  onThemeChanged: () => void;
}

const VIEW_LABELS: Record<MainView, string> = {
  Editor: 'rail.editor',
  History: 'rail.history',
  Settings: 'rail.settings',
};
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];

/** The Cropa mark: two crop corners around an accent square. */
function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="pointer-events-none size-5" fill="none" aria-hidden="true">
      <path
        d="M9 3v16a4 4 0 0 0 4 4h16M3 9h16a4 4 0 0 1 4 4v16"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-foreground"
      />
      <rect x="13" y="13" width="6" height="6" rx="1.5" className="fill-ring" />
    </svg>
  );
}

/** 10px glyphs drawn as 1px lines, like the Windows window buttons. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 10 10"
      className="size-2.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const MINIMIZE_GLYPH = (
  <Glyph>
    <path d="M0 5.5h10" />
  </Glyph>
);
const MAXIMIZE_GLYPH = (
  <Glyph>
    <rect x="0.5" y="0.5" width="9" height="9" />
  </Glyph>
);
const RESTORE_GLYPH = (
  <Glyph>
    <path d="M2.5 2.5v-2h7v7h-2" />
    <rect x="0.5" y="2.5" width="7" height="7" />
  </Glyph>
);
const CLOSE_GLYPH = (
  <Glyph>
    <path d="m0 0 10 10M10 0 0 10" />
  </Glyph>
);

interface WindowButtonProps {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}

function WindowButton({ label, onClick, danger = false, children }: WindowButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-11 w-[46px] items-center justify-center text-foreground transition-colors duration-150 ease-enter focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        danger ? 'hover:bg-[#c42b1c] hover:text-white' : 'hover:bg-accent',
      )}
    >
      {children}
    </button>
  );
}

/** The custom title bar of the main window: logo, menus, a drag area and the window buttons. */
export function TitleBar({ view, onView, onAbout, onError, onThemeChanged }: Props) {
  const { t } = useTranslation();
  const { actions, exportPreset } = useEditorActions();
  const [shortcut, setShortcut] = useState<string>();
  const [theme, setTheme] = useState<ThemePreference>();
  const [maximized, setMaximized] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  // A closing menu hands focus back to its trigger. After an item ran, the item
  // may have moved focus itself (a popover, a dialog, another view), so the menu
  // must not take it back; closing with Escape or a click outside still returns it.
  const picked = useRef(false);
  const pick = <A extends unknown[]>(action: (...args: A) => void) => (...args: A) => {
    picked.current = true;
    action(...args);
  };
  const keepFocus = (event: Event) => {
    if (picked.current) event.preventDefault();
    picked.current = false;
  };

  useEffect(() => {
    void commands.getShortcutStatus().then((status) => { setShortcut(status.accelerator); });
    const unlisten = events.shortcutStatus.listen((event) => { setShortcut(event.payload.accelerator); });
    return () => { void unlisten.then((off) => { off(); }); };
  }, []);

  const fail = useCallback((cause: unknown) => { onError(describeUnexpected(t, cause)); }, [onError, t]);

  const loadTheme = useCallback(() => {
    commands.getSettings().then((settings) => { setTheme(settings.theme); }).catch(fail);
  }, [fail]);
  useEffect(loadTheme, [loadTheme]);

  useEffect(() => {
    const win = getCurrentWindow();
    let stopped = false;
    const sync = () => {
      win.isMaximized().then((next) => { if (!stopped) setMaximized(next); }).catch(fail);
    };
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      stopped = true;
      void unlisten.then((off) => { off(); });
    };
  }, [fail]);

  const chooseTheme = (value: string) => {
    const next = value as ThemePreference;
    commands
      .setTheme(next)
      .then((result) => {
        if (result.status === 'ok') {
          setTheme(next);
          onThemeChanged();
        } else {
          onError(describeCommandError(t, result.error));
        }
      })
      .catch(fail);
  };

  const captureRegion = () => {
    requestCaptureAfterPaint().catch(fail);
  };

  const inEditor = view === 'Editor';
  const loaded = inEditor && (actions?.hasImage ?? false);
  // A popover left open must not come back when the editor does.
  if (!loaded && saveOpen) setSaveOpen(false);
  const canExport = loaded && !(actions?.busy ?? false);
  const canUndo = loaded && (actions?.canUndo ?? false);
  const canRedo = loaded && (actions?.canRedo ?? false);

  const win = getCurrentWindow();
  const run = (job: Promise<unknown>) => { job.catch(fail); };
  const openSupport = () => {
    commands
      .openSponsorsPage()
      .then((result) => {
        if (result.status === 'error') onError(describeCommandError(t, result.error));
      })
      .catch(fail);
  };

  return (
    <header
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-center bg-sidebar select-none"
    >
      <div data-tauri-drag-region className="flex h-11 w-[68px] items-center justify-center">
        <Logo />
      </div>
      <Menubar aria-label={t('menu.label')} onValueChange={(open) => { if (open) loadTheme(); }}>
        <MenubarMenu>
          <MenubarTrigger>{t('menu.file.title')}</MenubarTrigger>
          <MenubarContent className="min-w-64" onCloseAutoFocus={keepFocus}>
            <MenubarItem onSelect={pick(captureRegion)}>
              {t('menu.file.captureRegion')}
              {shortcut && <MenubarShortcut>{shortcut}</MenubarShortcut>}
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem disabled={!canExport} onSelect={pick(() => { actions?.copy(); })}>
              {t('menu.copyImage')}
              <MenubarShortcut>Ctrl+C</MenubarShortcut>
            </MenubarItem>
            <MenubarItem disabled={!canExport} onSelect={pick(() => { actions?.quickSave(); })}>
              {t('menu.file.save')}
              <MenubarShortcut>Ctrl+S</MenubarShortcut>
            </MenubarItem>
            <MenubarItem disabled={!canExport} onSelect={pick(() => { actions?.saveAs(); })}>
              {t('menu.file.saveAs')}
              <MenubarShortcut>Ctrl+Shift+S</MenubarShortcut>
            </MenubarItem>
            <MenubarItem
              disabled={!loaded || exportPreset === null}
              onSelect={pick(() => { exportPreset?.(); })}
            >
              {t('menu.file.exportPreset')}
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onSelect={pick(() => { run(win.close()); })}>
              {t('menu.file.closeWindow')}
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>{t('menu.edit.title')}</MenubarTrigger>
          <MenubarContent className="min-w-56" onCloseAutoFocus={keepFocus}>
            <MenubarItem disabled={!canUndo} onSelect={pick(() => { actions?.undo(); })}>
              {t('editor.undo')}
              <MenubarShortcut>Ctrl+Z</MenubarShortcut>
            </MenubarItem>
            <MenubarItem disabled={!canRedo} onSelect={pick(() => { actions?.redo(); })}>
              {t('editor.redo')}
              <MenubarShortcut>Ctrl+Y</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem disabled={!canExport} onSelect={pick(() => { actions?.copy(); })}>
              {t('menu.copyImage')}
              <MenubarShortcut>Ctrl+C</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>{t('menu.view.title')}</MenubarTrigger>
          <MenubarContent className="min-w-56" onCloseAutoFocus={keepFocus}>
            <MenubarRadioGroup
              value={view}
              onValueChange={pick((next: string) => { onView(next as MainView); })}
            >
              {(Object.keys(VIEW_LABELS) as MainView[]).map((name) => (
                <MenubarRadioItem key={name} value={name}>
                  {t(VIEW_LABELS[name])}
                </MenubarRadioItem>
              ))}
            </MenubarRadioGroup>
            <MenubarSeparator />
            <MenubarSub>
              <MenubarSubTrigger>{t('menu.view.theme')}</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarRadioGroup value={theme ?? ''} onValueChange={pick(chooseTheme)}>
                  {THEMES.map((value) => (
                    <MenubarRadioItem key={value} value={value}>
                      {t(`settings.theme.${value}`)}
                    </MenubarRadioItem>
                  ))}
                </MenubarRadioGroup>
              </MenubarSubContent>
            </MenubarSub>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>{t('menu.help.title')}</MenubarTrigger>
          <MenubarContent className="min-w-56" onCloseAutoFocus={keepFocus}>
            <MenubarItem onSelect={pick(onAbout)}>{t('menu.help.about')}</MenubarItem>
            <MenubarItem onSelect={pick(openSupport)}>{t('menu.help.support')}</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>

      {/* The free area drags; the buttons in its middle are not part of it. */}
      <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center justify-center">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('editor.undo')}
            title={`${t('editor.undo')} (Ctrl+Z)`}
            disabled={!canUndo}
            onClick={() => { actions?.undo(); }}
          >
            <UndoIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('editor.redo')}
            title={`${t('editor.redo')} (Ctrl+Y)`}
            disabled={!canRedo}
            onClick={() => { actions?.redo(); }}
          >
            <RedoIcon />
          </Button>
        </div>
      </div>

      <div className="mr-2 flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('editor.export.drag')}
          title={t('editor.export.dragHint')}
          draggable={false}
          className="cursor-grab touch-none"
          disabled={!canExport}
          {...actions?.dragHandlers}
        >
          <DragOutIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('editor.export.copy')}
          title={`${t('editor.export.copy')} (Ctrl+C)`}
          disabled={!canExport}
          onClick={() => { actions?.copy(); }}
        >
          <CopyIcon />
        </Button>
        <Popover open={saveOpen} onOpenChange={setSaveOpen}>
          <PopoverTrigger asChild>
            <Button
              size="icon-sm"
              aria-label={t('editor.export.save')}
              title={t('editor.export.saveOptions')}
              disabled={!loaded}
            >
              <SaveIcon />
            </Button>
          </PopoverTrigger>
          {actions && (
            <SavePopover
              options={actions.exportOptions}
              busy={actions.busy}
              onSave={() => {
                setSaveOpen(false);
                actions.quickSave();
              }}
              onSaveAs={() => {
                setSaveOpen(false);
                actions.saveAs();
              }}
            />
          )}
        </Popover>
      </div>

      <div className="flex h-11">
        <WindowButton label={t('window.minimize')} onClick={() => { run(win.minimize()); }}>
          {MINIMIZE_GLYPH}
        </WindowButton>
        <WindowButton
          label={maximized ? t('window.restore') : t('window.maximize')}
          onClick={() => { run(win.toggleMaximize()); }}
        >
          {maximized ? RESTORE_GLYPH : MAXIMIZE_GLYPH}
        </WindowButton>
        <WindowButton label={t('window.close')} danger onClick={() => { run(win.close()); }}>
          {CLOSE_GLYPH}
        </WindowButton>
      </div>
    </header>
  );
}
