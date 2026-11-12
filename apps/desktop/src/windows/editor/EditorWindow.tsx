import { defaultScene, edgeColor } from '@cropa/core';
import { Button } from '@cropa/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EditorSidebar } from '../../features/editor/EditorSidebar.tsx';
import { dataUrlToBitmap } from '../../features/editor/load-image.ts';
import { ScenePreview } from '../../features/editor/ScenePreview.tsx';
import { useSceneHistory } from '../../features/editor/use-scene-history.ts';
import { commands, events } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import {
  describeCommandError,
  describeEditorImage,
  describeUnexpected,
  type UserError,
} from '../../lib/errors.ts';

interface Loaded {
  bitmap: ImageBitmap;
  /** The colour at the screenshot's edges, found once per image. */
  edge: string | null;
}

const placeholder = defaultScene({ width: 1, height: 1 });

function findEdgeColor(bitmap: ImageBitmap): string | null {
  try {
    return edgeColor(bitmap, (w, h) => {
      const ctx = new OffscreenCanvas(w, h).getContext('2d');
      if (!ctx) throw new Error('2D canvas is not available');
      return ctx;
    });
  } catch {
    return null;
  }
}

/** True when the key press belongs to a text field, which has its own undo. */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return ['text', 'number', 'search', 'email', 'url', 'tel', 'password'].includes(target.type);
}

function UndoIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5 3 6.5l3 3" />
      <path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H7" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m10 3.5 3 3-3 3" />
      <path d="M13 6.5H6.5a3.5 3.5 0 0 0 0 7H9" />
    </svg>
  );
}

export function EditorWindow() {
  const { t } = useTranslation();
  const [shortcut, setShortcut] = useState<string>();
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<UserError>();
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; });
  const history = useSceneHistory(placeholder);
  const { load, undo, redo } = history;
  // Only the newest load may apply: an older decode can finish later.
  const loadId = useRef(0);

  useEffect(() => {
    void commands.getShortcutStatus().then((status) => {
      setShortcut(status.accelerator);
    });
    const unlistenStatus = events.shortcutStatus.listen((event) => {
      setShortcut(event.payload.accelerator);
    });

    const loadImage = () => {
      const id = ++loadId.current;
      const failed = (next: UserError) => {
        if (id === loadId.current) setError(next);
      };
      commands
        .getEditorImage()
        .then(async (result) => {
          if (id !== loadId.current) return;
          if (result.status === 'error') {
            failed(describeCommandError(tRef.current, result.error));
            return;
          }
          if (!result.data) return;
          const bitmap = await dataUrlToBitmap(result.data).catch((cause: unknown) => {
            failed(describeEditorImage(tRef.current, cause));
            return undefined;
          });
          if (!bitmap) return;
          if (id !== loadId.current) {
            bitmap.close();
            return;
          }
          setError(undefined);
          setLoaded({ bitmap, edge: findEdgeColor(bitmap) });
          load(defaultScene({ width: bitmap.width, height: bitmap.height }));
        })
        .catch((cause: unknown) => { failed(describeUnexpected(tRef.current, cause)); });
    };
    loadImage();
    const unlistenImage = events.editorImageChanged.listen(loadImage);
    return () => {
      loadId.current += 1;
      void unlistenStatus.then((off) => { off(); });
      void unlistenImage.then((off) => { off(); });
    };
  }, [load]);

  // Frees a bitmap when a newer image replaces it and when the window closes.
  const bitmap = loaded?.bitmap;
  useEffect(() => () => { bitmap?.close(); }, [bitmap]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || isTextField(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) undo();
      else if (key === 'y' || (key === 'z' && event.shiftKey)) redo();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [undo, redo]);

  return (
    <main className="flex h-screen flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background px-3">
        <h1 className="mr-auto text-sm font-medium">{t('editor.title')}</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('editor.undo')}
          title={`${t('editor.undo')} (Ctrl+Z)`}
          disabled={!loaded || !history.canUndo}
          onClick={undo}
        >
          <UndoIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('editor.redo')}
          title={`${t('editor.redo')} (Ctrl+Y)`}
          disabled={!loaded || !history.canRedo}
          onClick={redo}
        >
          <RedoIcon />
        </Button>
      </header>
      {loaded ? (
        <div className="flex min-h-0 flex-1">
          {/* The first slot of this row is left free for the annotation toolbar. */}
          <section className="relative flex min-w-0 flex-1 bg-canvas">
            <ScenePreview scene={history.scene} bitmap={loaded.bitmap} />
            {error && (
              <div className="absolute inset-x-4 top-4">
                <ErrorNotice error={error} />
              </div>
            )}
          </section>
          <aside className="w-72 shrink-0 overflow-y-auto border-l bg-background">
            <EditorSidebar history={history} edgeColor={loaded.edge} />
          </aside>
        </div>
      ) : (
        <section className="flex flex-1 flex-col items-center justify-center gap-3 bg-canvas p-8 text-center text-canvas-foreground">
          {error && <ErrorNotice error={error} />}
          <p className="text-lg text-foreground">{t('editor.empty')}</p>
          {shortcut && <p>{t('editor.hint', { shortcut })}</p>}
        </section>
      )}
    </main>
  );
}
