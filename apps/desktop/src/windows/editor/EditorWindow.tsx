import { defaultScene, edgeColor } from '@cropa/core';
import {
  Button,
  Popover,
  PopoverAnchor,
  PopoverContent,
  SegmentedControl,
  SegmentedControlItem,
} from '@cropa/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AnnotationOverlay } from '../../features/editor/annotate/AnnotationOverlay.tsx';
import { AnnotationProperties } from '../../features/editor/annotate/AnnotationProperties.tsx';
import { AnnotationToolbar } from '../../features/editor/annotate/AnnotationToolbar.tsx';
import { useAnnotate } from '../../features/editor/annotate/use-annotate.ts';
import { EditorSidebar } from '../../features/editor/EditorSidebar.tsx';
import { exportPlan, type ExportScale } from '../../features/editor/export/plan.ts';
import { useExport } from '../../features/editor/export/use-export.ts';
import { loadInter } from '../../features/editor/fonts.ts';
import { isTextField, keyLetter } from '../../features/editor/keyboard.ts';
import { dataUrlToBitmap } from '../../features/editor/load-image.ts';
import { ScenePreview } from '../../features/editor/ScenePreview.tsx';
import { useSceneHistory } from '../../features/editor/use-scene-history.ts';
import { commands, events, type ExportFormat } from '../../lib/bindings.ts';
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
  /** Counts loaded images; bumped on every successful load. */
  imageId: number;
  /** When the image was captured, in ms since the epoch; null when Rust does not know. */
  capturedAt: number | null;
}

const FORMATS: readonly ExportFormat[] = ['png', 'jpeg', 'webp'];
const SCALES: readonly ExportScale[] = [1, 2];

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

function UndoIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3.5 3 6.5l3 3" />
      <path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H7" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="5.5" cy="3.5" r="1.25" />
      <circle cx="10.5" cy="3.5" r="1.25" />
      <circle cx="5.5" cy="8" r="1.25" />
      <circle cx="10.5" cy="8" r="1.25" />
      <circle cx="5.5" cy="12.5" r="1.25" />
      <circle cx="10.5" cy="12.5" r="1.25" />
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
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('png');
  const [scale, setScale] = useState<ExportScale>(2);
  const history = useSceneHistory(placeholder);
  const { load } = history;
  const hasImage = loaded !== undefined;
  const annotate = useAnnotate({ history, imageId: loaded?.imageId ?? 0, enabled: hasImage });
  const { undo, redo } = annotate;
  // While a text is being edited, its glyphs are the text field's; the renderer skips empty text.
  const editingIndex = annotate.editing?.index ?? null;
  const displayScene = useMemo(
    () =>
      editingIndex === null
        ? history.scene
        : {
            ...history.scene,
            annotations: history.scene.annotations.map((a, i) =>
              i === editingIndex ? { ...a, text: '' } : a,
            ),
          },
    [history.scene, editingIndex],
  );
  const showProperties = annotate.tool !== 'select' || annotate.selected !== null;
  const exporter = useExport({
    scene: history.scene,
    bitmap: loaded?.bitmap,
    imageId: loaded?.imageId ?? 0,
    capturedAt: loaded?.capturedAt ?? null,
  });
  const { busy, quickSave, saveAs, copy, reveal, dragHandlers } = exporter;
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
          const data = result.data;
          if (!data) return;
          const bitmap = await dataUrlToBitmap(data.image).catch((cause: unknown) => {
            failed(describeEditorImage(tRef.current, cause));
            return undefined;
          });
          if (!bitmap) return;
          if (id !== loadId.current) {
            bitmap.close();
            return;
          }
          // The renderer draws text in Inter; load it before the first frame.
          await loadInter();
          if (id !== loadId.current) {
            bitmap.close();
            return;
          }
          setError(undefined);
          setLoaded((previous) => ({
            bitmap,
            edge: findEdgeColor(bitmap),
            imageId: (previous?.imageId ?? 0) + 1,
            capturedAt: data.capturedAt,
          }));
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
      const letter = keyLetter(event);
      const is = (wanted: string) => letter === wanted;
      if (is('z') && !event.shiftKey) undo();
      else if (is('y') || (is('z') && event.shiftKey)) redo();
      else if (is('s')) {
        if (hasImage) {
          if (event.shiftKey) setSaveAsOpen(true);
          else void quickSave();
        }
      } else if (is('c') && !event.shiftKey) {
        // Leave Ctrl+C alone while text is selected.
        if (window.getSelection()?.isCollapsed === false) return;
        if (hasImage) void copy();
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [undo, redo, quickSave, copy, hasImage]);

  const scaleFixed = history.scene.output.width !== null;
  const fixedSize = exportPlan(history.scene, format, scale);

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
        <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <Button
          variant="outline"
          className="cursor-grab touch-none select-none"
          title={t('editor.export.dragHint')}
          draggable={false}
          disabled={!loaded || busy}
          {...dragHandlers}
        >
          <GripIcon />
          {t('editor.export.drag')}
        </Button>
        <Button
          variant="outline"
          title={`${t('editor.export.copy')} (Ctrl+C)`}
          disabled={!loaded || busy}
          onClick={() => { void copy(); }}
        >
          {t('editor.export.copy')}
        </Button>
        <Popover open={saveAsOpen} onOpenChange={setSaveAsOpen}>
          <PopoverAnchor asChild>
            <Button
              variant="outline"
              title={`${t('editor.export.saveAs')} (Ctrl+Shift+S)`}
              disabled={!loaded || busy}
              onClick={() => { setSaveAsOpen((open) => !open); }}
            >
              {t('editor.export.saveAs')}
            </Button>
          </PopoverAnchor>
          <PopoverContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm">{t('editor.export.format')}</span>
              <SegmentedControl
                aria-label={t('editor.export.format')}
                value={format}
                onValueChange={(next) => { setFormat(next as ExportFormat); }}
              >
                {FORMATS.map((f) => (
                  <SegmentedControlItem key={f} value={f}>
                    {f.toUpperCase()}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm">{t('editor.export.scale')}</span>
              <SegmentedControl
                aria-label={t('editor.export.scale')}
                value={String(scaleFixed ? 1 : scale)}
                disabled={scaleFixed}
                onValueChange={(next) => { setScale(Number(next) as ExportScale); }}
              >
                {SCALES.map((s) => (
                  <SegmentedControlItem key={s} value={String(s)}>
                    {`${String(s)}x`}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
              {scaleFixed && (
                <p className="text-sm text-muted-foreground tabular-nums">
                  {t('editor.export.scaleFixed', {
                    width: fixedSize.width,
                    height: fixedSize.height,
                  })}
                </p>
              )}
            </div>
            <Button
              onClick={() => {
                setSaveAsOpen(false);
                void saveAs(format, scale);
              }}
            >
              {t('editor.export.saveAsConfirm')}
            </Button>
          </PopoverContent>
        </Popover>
        <Button
          title={`${t('editor.export.save')} (Ctrl+S)`}
          disabled={!loaded || busy}
          onClick={() => { void quickSave(); }}
        >
          {t('editor.export.save')}
        </Button>
      </header>
      {loaded ? (
        <div className="flex min-h-0 flex-1">
          <AnnotationToolbar tool={annotate.tool} onTool={annotate.setTool} disabled={!hasImage} />
          <section className="relative flex min-w-0 flex-1 bg-canvas">
            <ScenePreview
              scene={displayScene}
              bitmap={loaded.bitmap}
              overlay={(geometry) => (
                <AnnotationOverlay annotate={annotate} scene={displayScene} geometry={geometry} />
              )}
            />
            {showProperties && <AnnotationProperties annotate={annotate} />}
            {error ? (
              <div className={`absolute inset-x-4 ${showProperties ? 'top-16' : 'top-4'}`}>
                <ErrorNotice error={error} />
              </div>
            ) : (
              exporter.error && (
                <div className={`absolute inset-x-4 ${showProperties ? 'top-16' : 'top-4'}`}>
                  <ErrorNotice error={exporter.error} onDismiss={exporter.dismissError} />
                </div>
              )
            )}
            {exporter.notice && (
              <div
                role="status"
                className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md border bg-background py-1 pr-1 pl-3 text-sm shadow-md"
              >
                <span>
                  {exporter.notice.kind === 'saved' && t('editor.export.saved', { fileName: exporter.notice.file.fileName })}
                  {exporter.notice.kind === 'copied' && t('editor.export.copied')}
                  {exporter.notice.kind === 'dragHint' && t('editor.export.dragHold')}
                </span>
                {exporter.notice.kind === 'saved' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (exporter.notice?.kind === 'saved') void reveal(exporter.notice.file.id);
                    }}
                  >
                    {t('editor.export.openFolder')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={t('editor.dismiss')}
                  onClick={exporter.dismissNotice}
                >
                  <CloseIcon />
                </Button>
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
