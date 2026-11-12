import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, events } from '../../lib/bindings.ts';

export function EditorWindow() {
  const { t } = useTranslation();
  const [shortcut, setShortcut] = useState<string>();
  const [image, setImage] = useState<string>();

  useEffect(() => {
    void commands.getShortcutStatus().then((status) => {
      setShortcut(status.accelerator);
    });
    const unlistenStatus = events.shortcutStatus.listen((event) => {
      setShortcut(event.payload.accelerator);
    });

    let mounted = true;
    const loadImage = () => {
      void commands.getEditorImage().then((result) => {
        if (mounted && result.status === 'ok') setImage(result.data ?? undefined);
      });
    };
    loadImage();
    const unlistenImage = events.editorImageChanged.listen(loadImage);
    return () => {
      mounted = false;
      void unlistenStatus.then((off) => { off(); });
      void unlistenImage.then((off) => { off(); });
    };
  }, []);

  return (
    <main className="flex h-screen flex-col">
      <header className="border-b px-4 py-3 text-sm font-medium">{t('editor.title')}</header>
      {image ? (
        <section className="flex min-h-0 flex-1 items-center justify-center bg-canvas p-8">
          <img
            src={image}
            alt={t('editor.imageAlt')}
            className="max-h-full max-w-full object-contain shadow-lg"
          />
        </section>
      ) : (
        <section className="flex flex-1 flex-col items-center justify-center gap-3 bg-canvas p-8 text-center text-canvas-foreground">
          <p className="text-lg text-foreground">{t('editor.empty')}</p>
          {shortcut && <p>{t('editor.hint', { shortcut })}</p>}
        </section>
      )}
    </main>
  );
}
