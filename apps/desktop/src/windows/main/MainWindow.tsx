import { cn } from '@cropa/ui';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { ABOUT_SECTION_ID } from '../../features/settings/SettingsLayout.tsx';
import { AppRail } from '../../features/shell/AppRail.tsx';
import { TitleBar } from '../../features/shell/TitleBar.tsx';
import { ViewActiveContext } from '../../features/shell/view-active.ts';
import { commands, events, type MainView } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import type { UserError } from '../../lib/errors.ts';
import { EditorView } from '../editor/EditorWindow.tsx';
import { HistoryView } from '../history/HistoryWindow.tsx';
import { SettingsView } from '../settings/SettingsWindow.tsx';

/**
 * The one window of the app: a title bar across the top, then the rail on the
 * left and the editor, history and settings views on the right. A view is mounted on its first visit and then
 * only hidden, so the editor keeps its image, scene and undo history while
 * another view is open.
 */
export function MainWindow() {
  const [view, setView] = useState<MainView>('Editor');
  const [visited, setVisited] = useState<ReadonlySet<MainView>>(() => new Set<MainView>(['Editor']));

  // One notice for what the title bar's menus and window buttons could not do.
  const [error, setError] = useState<UserError>();
  // Goes up when the title bar changes a setting that the settings view shows.
  const [settingsVersion, setSettingsVersion] = useState(0);

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

  // The settings view may not be mounted yet, and loads before it shows the card.
  const showAbout = useCallback(() => {
    show('Settings');
    let tries = 0;
    const scroll = () => {
      const card = document.getElementById(ABOUT_SECTION_ID);
      if (card) card.scrollIntoView({ block: 'start' });
      else if (++tries < 60) requestAnimationFrame(scroll);
    };
    requestAnimationFrame(scroll);
  }, [show]);

  // A pane that comes to the front fades in; History and Settings sit in a panel of their own.
  const pane = (which: MainView, children: ReactNode, panel = true) => (
    <ViewActiveContext.Provider value={view === which}>
      <div
        hidden={view !== which}
        className={cn(
          'flex min-w-0 flex-1 animate-fade-in',
          panel && 'm-1.5 ml-0 overflow-hidden rounded-2xl bg-panel',
        )}
      >
        {children}
      </div>
    </ViewActiveContext.Provider>
  );

  return (
    <div className="flex h-screen flex-col">
      <TitleBar
        view={view}
        onView={show}
        onAbout={showAbout}
        onError={setError}
        onThemeChanged={() => { setSettingsVersion((version) => version + 1); }}
      />
      {error && (
        <div className="fixed bottom-4 left-24 z-50 w-96">
          <ErrorNotice error={error} onDismiss={() => { setError(undefined); }} />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <AppRail current={view} onSelect={show} />
        {pane('Editor', <EditorView />, false)}
        {visited.has('History') && pane('History', <HistoryView />)}
        {visited.has('Settings') && pane('Settings', <SettingsView settingsVersion={settingsVersion} />)}
      </div>
    </div>
  );
}
