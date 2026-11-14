import { defaultScene, edgeColor, type PaletteColour } from '@cropa/core';
import { Button, CloseIcon } from '@cropa/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AnnotationOverlay } from '../../features/editor/annotate/AnnotationOverlay.tsx';
import { AnnotationProperties } from '../../features/editor/annotate/AnnotationProperties.tsx';
import { AnnotationToolbar } from '../../features/editor/annotate/AnnotationToolbar.tsx';
import { useAnnotate } from '../../features/editor/annotate/use-annotate.ts';
import { screenshotPalette } from '../../features/editor/code-frames.ts';
import { requestCaptureAfterPaint } from '../../features/shell/capture.ts';
import { publishEditorActions, type ExportOptions } from '../../features/shell/editor-actions.ts';
import { useViewActive } from '../../features/shell/view-active.ts';
import { EditorSidebar } from '../../features/editor/EditorSidebar.tsx';
import { EXPORT_SIZES, exportPlan, type ExportSize } from '../../features/editor/export/plan.ts';
import { useExport } from '../../features/editor/export/use-export.ts';
import { loadInter } from '../../features/editor/fonts.ts';
import { isTextField, keyLetter } from '../../features/editor/keyboard.ts';
import { beginBackgroundChange } from '../../features/editor/background-images.ts';
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
  /** The dominant colours of the screenshot, found once per image. */
  palette: PaletteColour[];
  /** Counts loaded images; bumped on every successful load. */
  imageId: number;
  /** When the image was captured, in ms since the epoch; null when Rust does not know. */
  capturedAt: number | null;
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

/** Two crop corners around a square: the mark of an empty canvas. */
function EmptyMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-14 text-tertiary-foreground" fill="none" aria-hidden="true">
      <path
        d="M13 5v24a6 6 0 0 0 6 6h24M5 13h24a6 6 0 0 1 6 6v24"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="19" y="19" width="10" height="10" rx="2" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

export function EditorView() {
  const { t } = useTranslation();
  // Hidden while another view is open: the keyboard shortcuts then belong to that view.
  const active = useViewActive();
  const [shortcut, setShortcut] = useState<string>();
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<UserError>();
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; });
  const [format, setFormat] = useState<ExportFormat>('png');
  const [size, setSize] = useState<ExportSize>('2k');
  const history = useSceneHistory(placeholder);
  const { load } = history;
  const hasImage = loaded !== undefined;
  const annotate = useAnnotate({ history, imageId: loaded?.imageId ?? 0, enabled: hasImage && active });
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
  // An export error wins over the warning that a layer was left out.
  const exportProblem = exporter.error ?? exporter.warning;
  const { busy, quickSave, saveAs, copy, reveal, dragHandlers } = exporter;
  const saveAsChosen = useCallback(() => saveAs(format, size), [saveAs, format, size]);
  const quickSaveChosen = useCallback(() => quickSave(format, size), [quickSave, format, size]);
  const imageWidth = loaded?.bitmap.width ?? 0;
  const imageHeight = loaded?.bitmap.height ?? 0;
  const exportOptions = useMemo<ExportOptions>(() => {
    const sizes = Object.fromEntries(
      EXPORT_SIZES.map((choice) => {
        const { width, height } = exportPlan(history.scene, format, choice);
        return [choice, { width, height }];
      }),
    ) as ExportOptions['sizes'];
    return {
      format,
      size,
      setFormat,
      setSize,
      imageSize: { width: imageWidth, height: imageHeight },
      output: sizes[size],
      sizes,
      sizeFixed: history.scene.output.width !== null,
    };
  }, [history.scene, format, size, imageWidth, imageHeight]);
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
      // A background still loading belongs to the scene of the previous capture.
      beginBackgroundChange();
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
          const palette = screenshotPalette(bitmap);
          setLoaded((previous) => ({
            bitmap,
            edge: findEdgeColor(bitmap),
            palette,
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
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || isTextField(event.target)) return;
      const letter = keyLetter(event);
      const is = (wanted: string) => letter === wanted;
      if (is('z') && !event.shiftKey) undo();
      else if (is('y') || (is('z') && event.shiftKey)) redo();
      else if (is('s')) {
        if (hasImage) {
          if (event.shiftKey) void saveAsChosen();
          else void quickSaveChosen();
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
  }, [active, undo, redo, quickSaveChosen, saveAsChosen, copy, hasImage]);

  useEffect(() => {
    publishEditorActions({
      hasImage,
      busy,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undo,
      redo,
      copy: () => { void copy(); },
      quickSave: () => { void quickSaveChosen(); },
      saveAs: () => { void saveAsChosen(); },
      exportOptions,
      dragHandlers,
    });
  }, [hasImage, busy, history.canUndo, history.canRedo, undo, redo, copy, quickSaveChosen, saveAsChosen, exportOptions, dragHandlers]);
  useEffect(() => () => { publishEditorActions(null); }, []);

  const [captureError, setCaptureError] = useState<UserError>();
  const captureRegion = () => {
    requestCaptureAfterPaint().catch((cause: unknown) => {
      setCaptureError(describeUnexpected(t, cause));
    });
  };

  // Notices stack at the top centre of the canvas and slide in.
  const notices = (
    <div className="pointer-events-none absolute top-3 left-1/2 z-10 flex w-[min(28rem,calc(100%-1.5rem))] -translate-x-1/2 flex-col items-stretch gap-2">
      {error ? (
        <div className="pointer-events-auto">
          <ErrorNotice error={error} />
        </div>
      ) : (
        exportProblem && (
          <div className="pointer-events-auto">
            <ErrorNotice
              error={exportProblem}
              onDismiss={exporter.error ? exporter.dismissError : exporter.dismissWarning}
            />
          </div>
        )
      )}
      {exporter.notice && (
        <div
          role="status"
          className="pointer-events-auto flex animate-notice-in items-center gap-2 self-center rounded-full bg-card py-1 pr-1 pl-4 text-control-sm shadow-soft"
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
            size="icon-sm"
            aria-label={t('editor.dismiss')}
            onClick={exporter.dismissNotice}
          >
            <CloseIcon />
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <main className="flex min-w-0 flex-1 gap-1.5 p-1.5 pl-0">
      {loaded ? (
        <>
          <EditorSidebar history={history} edgeColor={loaded.edge} palette={loaded.palette} />
          <section className="relative flex min-w-0 flex-1 overflow-hidden rounded-2xl bg-canvas">
            <ScenePreview
              scene={displayScene}
              bitmap={loaded.bitmap}
              bottomInset={showProperties ? 112 : 56}
              overlay={(geometry) => (
                <AnnotationOverlay annotate={annotate} scene={displayScene} geometry={geometry} />
              )}
            />
            {notices}
            {/* The properties float just above the toolbar, so the two read as one group. */}
            <div className="pointer-events-none absolute inset-x-3 bottom-[60px] z-10 flex justify-center">
              {showProperties && <AnnotationProperties annotate={annotate} />}
            </div>
            <AnnotationToolbar tool={annotate.tool} onTool={annotate.setTool} disabled={!hasImage} />
          </section>
        </>
      ) : (
        <section className="relative flex flex-1 flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl bg-canvas p-8 text-center text-canvas-foreground">
          {notices}
          <EmptyMark />
          <p className="text-heading text-foreground">{t('editor.empty')}</p>
          {shortcut && <p className="max-w-sm text-control-sm font-normal">{t('editor.hint', { shortcut })}</p>}
          {captureError && <ErrorNotice error={captureError} onDismiss={() => { setCaptureError(undefined); }} />}
          <Button className="mt-1" onClick={captureRegion}>
            {t('menu.file.captureRegion')}
          </Button>
        </section>
      )}
    </main>
  );
}
