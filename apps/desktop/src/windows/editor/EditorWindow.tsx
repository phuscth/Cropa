import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, events, type CaptureSource } from '../../lib/bindings.ts';

interface LastCapture {
  source: CaptureSource;
  at: Date;
}

/** Phase 0 placeholder: proves the shortcut and tray reach the WebView. */
export function EditorWindow() {
  const { t, i18n } = useTranslation();
  const [shortcut, setShortcut] = useState<string>();
  const [last, setLast] = useState<LastCapture>();

  useEffect(() => {
    void commands.getShortcutStatus().then((status) => {
      setShortcut(status.accelerator);
    });
    const unlistenStatus = events.shortcutStatus.listen((event) => {
      setShortcut(event.payload.accelerator);
    });
    const unlistenCapture = events.captureRequested.listen((event) => {
      setLast({ source: event.payload.source, at: new Date() });
    });
    return () => {
      void unlistenStatus.then((off) => { off(); });
      void unlistenCapture.then((off) => { off(); });
    };
  }, []);

  return (
    <main className="flex h-screen flex-col">
      <header className="border-b px-4 py-3 text-sm font-medium">{t('editor.title')}</header>
      <section className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-lg">{t('editor.empty')}</p>
        {shortcut && (
          <p className="text-muted-foreground">
            {t('editor.hint', { shortcut })}
          </p>
        )}
        {last && (
          <p role="status" className="mt-4 rounded-md bg-muted px-3 py-2 text-sm">
            {t('editor.captureReceived', {
              source: t(`editor.source.${last.source}`),
              time: last.at.toLocaleTimeString(i18n.language),
            })}
          </p>
        )}
      </section>
    </main>
  );
}
