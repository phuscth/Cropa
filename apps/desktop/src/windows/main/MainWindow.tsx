import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { AppRail } from '../../features/shell/AppRail.tsx';
import { ViewActiveContext } from '../../features/shell/view-active.ts';
import { commands, events, type MainView } from '../../lib/bindings.ts';
import { EditorView } from '../editor/EditorWindow.tsx';
import { HistoryView } from '../history/HistoryWindow.tsx';
import { SettingsView } from '../settings/SettingsWindow.tsx';

/**
 * The one window of the app: the rail on the left, the editor, history and
 * settings views on the right. A view is mounted on its first visit and then
 * only hidden, so the editor keeps its image, scene and undo history while
 * another view is open.
 */
export function MainWindow() {
  const [view, setView] = useState<MainView>('Editor');
  const [visited, setVisited] = useState<ReadonlySet<MainView>>(() => new Set<MainView>(['Editor']));

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

  const pane = (which: MainView, children: ReactNode) => (
    <ViewActiveContext.Provider value={view === which}>
      <div hidden={view !== which} className="flex min-w-0 flex-1">
        {children}
      </div>
    </ViewActiveContext.Provider>
  );

  return (
    <div className="flex h-screen">
      <AppRail current={view} onSelect={show} />
      {pane('Editor', <EditorView />)}
      {visited.has('History') && pane('History', <HistoryView />)}
      {visited.has('Settings') && pane('Settings', <SettingsView />)}
    </div>
  );
}
