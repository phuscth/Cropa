import { cn } from '@cropa/ui';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { selectSettingsSection } from '../../features/settings/sections.ts';
import { TitleBar } from '../../features/shell/TitleBar.tsx';
import { ViewActiveContext } from '../../features/shell/view-active.ts';
import { commands, events, type MainView } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import { describeUnexpected, type UserError } from '../../lib/errors.ts';
import { EditorView } from '../editor/EditorWindow.tsx';
import { HistoryView } from '../history/HistoryWindow.tsx';
import { SettingsView } from '../settings/SettingsWindow.tsx';

/**
 * The one window of the app: a title bar across the top with the buttons that
 * switch between the editor, history and settings views, and the view under it.
 * A view is mounted on its first visit and then only hidden, so the editor
 * keeps its image, scene and undo history while another view is open.
 */
export function MainWindow() {
  const { t } = useTranslation();
  const [view, setView] = useState<MainView>('Editor');
  const [visited, setVisited] = useState<ReadonlySet<MainView>>(() => new Set<MainView>(['Editor']));

  // One notice for what the title bar's buttons could not do.
  const [error, setError] = useState<UserError>();

  // Rounded corners only while restored: a maximized window meets the screen edges.
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let stopped = false;
    const sync = () => {
      win
        .isMaximized()
        .then((next) => { if (!stopped) setMaximized(next); })
        .catch((cause: unknown) => { if (!stopped) setError(describeUnexpected(t, cause)); });
    };
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      stopped = true;
      void unlisten.then((off) => { off(); });
    };
  }, [t]);

  const show = useCallback((next: MainView) => {
    setView(next);
    setVisited((previous) => (previous.has(next) ? previous : new Set(previous).add(next)));
  }, []);

  // Listen first, then ask, so a request made while the page loads is not missed.
  useEffect(() => {
    let requested = false;
    const unlisten = events.mainViewRequested.listen((event) => {
      requested = true;
      show(event.payload.view);
    });
    let stopped = false;
    void unlisten
      .then(() => commands.getMainView())
      .then((initial) => {
        if (!requested && !stopped) show(initial);
      })
      .catch(() => {
        // A state read that should not fail; the editor is the right fallback.
        if (!requested && !stopped) show('Editor');
      });
    return () => {
      stopped = true;
      void unlisten.then((off) => { off(); });
    };
  }, [show]);

  // The settings view reads the chosen page when it mounts, so this works before its first visit.
  const showAbout = useCallback(() => {
    selectSettingsSection('about');
    show('Settings');
  }, [show]);

  // A pane that comes to the front fades in; History and Settings sit in a panel of their own.
  const pane = (which: MainView, children: ReactNode, panel = true) => (
    <ViewActiveContext.Provider value={view === which}>
      <div
        hidden={view !== which}
        className={cn(
          'flex min-w-0 flex-1 animate-fade-in',
          panel && 'm-1.5 overflow-hidden rounded-2xl bg-panel',
        )}
      >
        {children}
      </div>
    </ViewActiveContext.Provider>
  );

  return (
    <div
      className={cn(
        'flex h-screen flex-col overflow-hidden bg-background',
        !maximized && 'rounded-2xl border',
      )}
    >
      <TitleBar
        maximized={maximized}
        view={view}
        onView={show}
        onAbout={showAbout}
        onError={setError}
      />
      {error && (
        <div className="fixed bottom-4 left-4 z-50 w-96">
          <ErrorNotice error={error} onDismiss={() => { setError(undefined); }} />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {pane('Editor', <EditorView />, false)}
        {visited.has('History') && pane('History', <HistoryView />)}
        {visited.has('Settings') && pane('Settings', <SettingsView />)}
      </div>
    </div>
  );
}
