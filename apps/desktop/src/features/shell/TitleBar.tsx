import {
  Button,
  ChatIcon,
  CopyIcon,
  DragOutIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EditorIcon,
  HelpIcon,
  HistoryIcon,
  IconButton,
  PanelCloseIcon,
  PanelOpenIcon,
  Popover,
  PopoverTrigger,
  RedoIcon,
  SaveIcon,
  SettingsIcon,
  UndoIcon,
  cn,
  type IconComponent,
} from '@cropa/ui';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import logoUrl from '../../../icon-src/icon.svg?url';
import { commands, type MainView } from '../../lib/bindings.ts';
import { describeCommandError, describeUnexpected, type UserError } from '../../lib/errors.ts';
import { toggleChatPanel, useChatPanelOpen } from '../chat/panel-state.ts';
import { toggleEditorSidebar, useEditorSidebarOpen } from '../editor/panel-state.ts';
import { useEditorActions } from './editor-actions.ts';
import { SavePopover } from './SavePopover.tsx';
import { StartOverConfirm } from './StartOverConfirm.tsx';

interface Props {
  /** Whether the window is maximized, for the maximize/restore button. */
  maximized: boolean;
  /** The view on screen. */
  view: MainView;
  onView: (view: MainView) => void;
  /** Shows the About card of the settings view. */
  onAbout: () => void;
  /** Reports a failed command or window call to the shell's notice. */
  onError: (error: UserError) => void;
}

const VIEWS: readonly { view: MainView; label: string; Icon: IconComponent }[] = [
  { view: 'Editor', label: 'nav.editor', Icon: EditorIcon },
  { view: 'History', label: 'nav.history', Icon: HistoryIcon },
  { view: 'Settings', label: 'nav.settings', Icon: SettingsIcon },
];

/** The Cropa logo, the same master the app icon is generated from (`apps/desktop/icon-src/icon.svg`). */
function Logo() {
  return (
    <img
      src={logoUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="pointer-events-none size-6 select-none"
    />
  );
}

/** In the editor the logo is the toggle of the left panel; hovering or focusing it shows the action. */
function PanelToggle() {
  const { t } = useTranslation();
  const open = useEditorSidebarOpen();
  const swap = 'transition-opacity duration-150 ease-enter';
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t('editor.panel.toggle')}
      aria-pressed={open}
      tooltip={{ label: t(open ? 'editor.panel.hide' : 'editor.panel.show'), keys: ['Ctrl', 'B'], align: 'start' }}
      className="group/logo relative"
      onClick={toggleEditorSidebar}
    >
      <span className={cn(swap, 'group-hover/logo:opacity-0 group-focus-visible/logo:opacity-0')}>
        <Logo />
      </span>
      <span
        aria-hidden="true"
        className={cn(
          swap,
          'absolute inset-0 flex items-center justify-center opacity-0 group-hover/logo:opacity-100 group-focus-visible/logo:opacity-100',
        )}
      >
        {open ? <PanelCloseIcon /> : <PanelOpenIcon />}
      </span>
    </Button>
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

/**
 * The custom title bar of the main window: logo, the view buttons and Help,
 * the editor's quick actions in a drag area, then export and the window buttons.
 */
export function TitleBar({ maximized, view, onView, onAbout, onError }: Props) {
  const { t } = useTranslation();
  const { actions } = useEditorActions();
  const [saveOpen, setSaveOpen] = useState(false);
  const chatOpen = useChatPanelOpen();
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

  const fail = useCallback((cause: unknown) => { onError(describeUnexpected(t, cause)); }, [onError, t]);

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
      <div data-tauri-drag-region className="flex h-11 w-12 items-center justify-center">
        {inEditor ? <PanelToggle /> : <Logo />}
      </div>
      {/* Above the views, so the tooltips stay on top even while a pressed button scales and becomes its own layer. */}
      <div data-tauri-drag-region className="relative z-50 flex h-full items-center gap-1">
        <nav aria-label={t('nav.label')} className="flex items-center gap-1">
          {VIEWS.map(({ view: name, label, Icon }) => (
            <IconButton
              key={name}
              icon={<Icon />}
              label={t(label)}
              active={view === name}
              onClick={() => { onView(name); }}
            />
          ))}
        </nav>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton icon={<HelpIcon />} label={t('menu.help.title')} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56" onCloseAutoFocus={keepFocus}>
            <DropdownMenuItem onSelect={pick(onAbout)}>{t('menu.help.about')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={pick(openSupport)}>{t('menu.help.support')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* The free area drags; the buttons in its middle are not part of it. */}
      <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center justify-center">
        <div className="relative z-50 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('editor.undo')}
            tooltip={{ label: t('editor.undo'), keys: ['Ctrl', 'Z'] }}
            disabled={!canUndo}
            onClick={() => { actions?.undo(); }}
          >
            <UndoIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('editor.redo')}
            tooltip={{ label: t('editor.redo'), keys: ['Ctrl', 'Y'] }}
            disabled={!canRedo}
            onClick={() => { actions?.redo(); }}
          >
            <RedoIcon />
          </Button>
          <StartOverConfirm
            disabled={!(inEditor && actions?.canStartOver)}
            maximized={maximized}
            onConfirm={() => { actions?.startOver(); }}
          />
        </div>
      </div>

      {/* Above the canvas, so the tooltips that drop below the title bar are not hidden under it. */}
      <div className="relative z-50 mr-2 flex items-center gap-1">
        {inEditor && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('chat.toggle')}
            aria-pressed={chatOpen}
            tooltip={{ label: t('chat.toggleHint') }}
            className={chatOpen ? 'bg-accent text-foreground' : undefined}
            onClick={toggleChatPanel}
          >
            <ChatIcon />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('editor.export.drag')}
          tooltip={{ label: t('editor.export.dragHint') }}
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
          tooltip={{ label: t('editor.export.copy'), keys: ['Ctrl', 'C'] }}
          disabled={!canExport}
          onClick={() => { actions?.copy(); }}
        >
          <CopyIcon />
        </Button>
        <Popover open={saveOpen} onOpenChange={setSaveOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="data-[state=open]:bg-accent data-[state=open]:text-foreground"
              aria-label={t('editor.export.save')}
              tooltip={{ label: t('editor.export.saveOptions') }}
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
