import { defaultScene, edgeColor, type PaletteColour } from '@cropa/core';
import { Button, cn, CloseIcon } from '@cropa/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CHAT_PANEL_WIDTH, ChatPanel } from '../../features/chat/ChatPanel.tsx';
import { PanelDock } from '../../features/editor/PanelDock.tsx';
import { toggleEditorSidebar, useEditorSidebarOpen } from '../../features/editor/panel-state.ts';
import { useChatPanelOpen, setChatPanelOpen } from '../../features/chat/panel-state.ts';
import { useBackgroundChat } from '../../features/chat/use-background-chat.ts';
import { AnnotationOverlay } from '../../features/editor/annotate/AnnotationOverlay.tsx';
import { AnnotationProperties } from '../../features/editor/annotate/AnnotationProperties.tsx';
import { AnnotationToolbar } from '../../features/editor/annotate/AnnotationToolbar.tsx';
import { useAnnotate } from '../../features/editor/annotate/use-annotate.ts';
import { screenshotPalette } from '../../features/editor/code-frames.ts';
import { requestCaptureAfterPaint } from '../../features/shell/capture.ts';
import { publishEditorActions, type ExportOptions } from '../../features/shell/editor-actions.ts';
import { useViewActive } from '../../features/shell/view-active.ts';
import { EditorSidebar, SIDEBAR_WIDTH } from '../../features/editor/EditorSidebar.tsx';
import { EXPORT_SIZES, exportPlan, type ExportSize } from '../../features/editor/export/plan.ts';
import { useExport } from '../../features/editor/export/use-export.ts';
import { EmptyCanvas } from '../../features/editor/EmptyCanvas.tsx';
import { ImagePicker } from '../../features/editor/ImagePicker.tsx';
import { useEmptyBitmap } from '../../features/editor/empty-bitmap.ts';
import { loadInter } from '../../features/editor/fonts.ts';
import { isDraggingOut } from '../../features/editor/export/use-export.ts';
import { fileToPng, MAX_IMPORT_PIXELS, pickImageFile } from '../../features/editor/import-image.ts';
import { isTextField, keyLetter } from '../../features/editor/keyboard.ts';
import { beginBackgroundChange, cacheImage } from '../../features/editor/background-images.ts';
import { useRemoveBackground } from '../../features/editor/remove-background/use-remove-background.ts';
import { dataUrlToBitmap } from '../../features/editor/load-image.ts';
import { shotRectCss } from '../../features/editor/annotate/geometry.ts';
import { maskRef, sceneForNewImage, setMask } from '../../features/editor/scene-edits.ts';
import { ScenePreview } from '../../features/editor/ScenePreview.tsx';
import { useSceneHistory } from '../../features/editor/use-scene-history.ts';
import { commands, events, type ExportFormat } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import {
  describeCommandError,
  describeEditorImage,
  describeImageImport,
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
  /** The capture's id in the history, when it is kept there. */
  historyId: string | null;
  /** Names the image to Rust, for the cut-outs made for it. */
  imageKey: string;
}

/** The size of the stand-in screenshot before an image is loaded: 4:3. */
const EMPTY_SIZE = { width: 1440, height: 1080 };
const emptyScene = defaultScene(EMPTY_SIZE);
const noPalette: PaletteColour[] = [];

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

export function EditorView() {
  const { t } = useTranslation();
  // Hidden while another view is open: the keyboard shortcuts then belong to that view.
  const active = useViewActive();
  const [shortcut, setShortcut] = useState<string>();
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<UserError>();
  const [importError, setImportError] = useState<UserError>();
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerAnchor = useRef<HTMLButtonElement>(null);
  const emptyBitmap = useEmptyBitmap();
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; });
  const [format, setFormat] = useState<ExportFormat>('png');
  const [size, setSize] = useState<ExportSize>('2k');
  const history = useSceneHistory(emptyScene);
  const { load } = history;
  const hasImage = loaded !== undefined;
  // Read by the image loader, which outlives renders: the first image keeps the scene chosen so far.
  const sceneNow = useRef(history.scene);
  const hasImageNow = useRef(hasImage);
  useEffect(() => {
    sceneNow.current = history.scene;
    hasImageNow.current = hasImage;
  });
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
  // One chat per editor, so a run goes on while the panel is hidden.
  const chat = useBackgroundChat({
    history,
    palette: loaded?.palette ?? noPalette,
    imageId: loaded?.imageId ?? 0,
    historyId: loaded?.historyId ?? null,
  });
  const removeBackground = useRemoveBackground({
    history,
    imageKey: loaded?.imageKey ?? null,
    bitmap: loaded?.bitmap,
  });
  const chatOpen = useChatPanelOpen();
  const sidebarOpen = useEditorSidebarOpen();
  // While the AI writes a background, the image is not exported: the result would replace it.
  const aiWorking = chat.state.run !== null;
  const showProperties = annotate.tool !== 'select' || annotate.selected !== null;
  const exporter = useExport({
    scene: history.scene,
    bitmap: loaded?.bitmap,
    imageId: loaded?.imageId ?? 0,
    capturedAt: loaded?.capturedAt ?? null,
    locked: aiWorking,
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
  // Never reused, so a new image after a start over still resets what is keyed on the id.
  const imageCount = useRef(0);
  // An import counts as running until the image it opened has loaded, or failed to.
  const importRunning = useRef(false);
  const endImport = useCallback(() => {
    importRunning.current = false;
    setImporting(false);
  }, []);

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
        if (id === loadId.current) {
          setError(next);
          endImport();
        }
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
          if (!data) {
            endImport();
            // The image was taken away: back to the empty canvas.
            if (hasImageNow.current) {
              setLoaded(undefined);
              setError(undefined);
              load(emptyScene);
            }
            return;
          }
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
          // A capture opened from the history comes back with the cut-out it was left with; it is
          // cached before the scene names it. One that cannot be decoded shows the whole image.
          let cutoutName: string | null = null;
          if (data.cutout) {
            const cutoutBitmap = await dataUrlToBitmap(data.cutout.image).catch(() => undefined);
            if (id !== loadId.current) {
              cutoutBitmap?.close();
              bitmap.close();
              return;
            }
            if (cutoutBitmap) {
              cacheImage(maskRef(data.cutout.name), cutoutBitmap);
              cutoutName = data.cutout.name;
            }
          }
          setError(undefined);
          endImport();
          setPickerOpen(false);
          const palette = screenshotPalette(bitmap);
          const imageId = ++imageCount.current;
          setLoaded(() => ({
            bitmap,
            edge: findEdgeColor(bitmap),
            palette,
            imageId,
            capturedAt: data.capturedAt,
            historyId: data.historyId,
            imageKey: data.imageKey,
          }));
          // The cut-out is the scene's first state, not an undo step.
          load(
            setMask(
              sceneForNewImage(hasImageNow.current ? null : sceneNow.current, {
                width: bitmap.width,
                height: bitmap.height,
              }),
              cutoutName,
            ),
          );
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
  }, [load, endImport]);

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
      } else if (is('b') && !event.shiftKey) {
        // Not on a key repeat, and not from inside an open popper layer: hiding the panel would
        // remove the layer's trigger and strand the layer.
        if (event.repeat || (event.target instanceof Element && event.target.closest('[data-radix-popper-content-wrapper]'))) return;
        toggleEditorSidebar();
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [active, undo, redo, quickSaveChosen, saveAsChosen, copy, hasImage]);

  // Clears the image in Rust; the image-changed event then empties the editor.
  // Through a ref, so `startOver` stays the same function and the title bar is not republished each render.
  const stopChat = useRef(chat.stop);
  const clearChat = useRef(chat.clear);
  useEffect(() => {
    stopChat.current = chat.stop;
    clearChat.current = chat.clear;
  });
  // A conversation that changed nothing on the canvas is still something to clear.
  const hasChat = chat.state.messages.length > 0 || chat.state.run !== null;
  const canStartOver = (hasImage || history.canUndo || history.canRedo || hasChat) && !busy;
  const startOver = useCallback(() => {
    stopChat.current();
    setPickerOpen(false);
    commands.clearEditorImage().then(
      (result) => {
        if (result.status === 'error') {
          setImportError(describeCommandError(tRef.current, result.error));
          return;
        }
        // Edits made on the empty canvas go too, whether or not an image was loaded.
        setError(undefined);
        load(emptyScene);
        // The empty canvas's conversation goes with its scene; an image change would not clear it.
        clearChat.current();
      },
      (cause: unknown) => { setImportError(describeUnexpected(tRef.current, cause)); },
    );
  }, [load]);

  useEffect(() => {
    publishEditorActions({
      hasImage,
      busy,
      aiWorking,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undo,
      redo,
      canStartOver,
      startOver,
      copy: () => { void copy(); },
      quickSave: () => { void quickSaveChosen(); },
      saveAs: () => { void saveAsChosen(); },
      exportOptions,
      dragHandlers,
    });
  }, [hasImage, busy, aiWorking, history.canUndo, history.canRedo, undo, redo, canStartOver, startOver, copy, quickSaveChosen, saveAsChosen, exportOptions, dragHandlers]);
  useEffect(() => () => { publishEditorActions(null); }, []);

  // Opens a file like a capture: Rust keeps and shows it, and the image-changed event loads it.
  const importFile = useCallback(async (file: File) => {
    if (importRunning.current) return;
    importRunning.current = true;
    setImporting(true);
    setPickerOpen(false);
    let started = false;
    try {
      const png = await fileToPng(file);
      if ('kind' in png) {
        setImportError(describeImageImport(tRef.current, png));
        return;
      }
      const result = await commands.importEditorImage(png.base64);
      if (result.status === 'error') {
        setImportError(
          describeCommandError(tRef.current, result.error, { megapixels: String(MAX_IMPORT_PIXELS / 1_000_000) }),
        );
        return;
      }
      setImportError(undefined);
      started = true;
    } catch (cause) {
      setImportError(describeUnexpected(tRef.current, cause));
    } finally {
      // After a success the editor-image event ends it, once the image has loaded.
      if (!started) endImport();
    }
  }, [endImport]);

  // The window has no native file-drop handler, so a dropped file arrives as an HTML5 drop. The
  // page must cancel it, or the WebView navigates to the file; only the editor view acts on it.
  const activeNow = useRef(active);
  useEffect(() => { activeNow.current = active; });
  useEffect(() => {
    let depth = 0;
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    // The app's own drag of the exported image also arrives as a file drag; it is never an import.
    const accepts = () => activeNow.current && !isDraggingOut();
    const onEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth += 1;
      if (accepts()) {
        setDragging(true);
        setPickerOpen(false);
      }
    };
    const onOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = accepts() ? 'copy' : 'none';
    };
    const onLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onEnd = () => {
      depth = 0;
      setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      onEnd();
      const file = accepts() && event.dataTransfer ? pickImageFile(event.dataTransfer.files) : undefined;
      if (file) void importFile(file);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onEnd);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onEnd);
    };
  }, [importFile]);

  useEffect(() => {
    if (!active) return;
    const onPaste = (event: ClipboardEvent) => {
      if (isTextField(event.target)) return;
      const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      if (!file) return;
      event.preventDefault();
      void importFile(file);
    };
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('paste', onPaste); };
  }, [active, importFile]);

  const closePicker = useCallback((returnFocus: boolean) => {
    setPickerOpen(false);
    if (returnFocus) pickerAnchor.current?.focus();
  }, []);

  const [captureError, setCaptureError] = useState<UserError>();
  const captureRegion = () => {
    requestCaptureAfterPaint().catch((cause: unknown) => {
      setCaptureError(describeUnexpected(t, cause));
    });
  };

  // Notices stack at the top centre of the canvas and slide in.
  const notices = (
    <div data-picker-keep className="pointer-events-none absolute top-3 left-1/2 z-40 flex w-[min(28rem,calc(100%-1.5rem))] -translate-x-1/2 flex-col items-stretch gap-2">
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
      {importError && (
        <div className="pointer-events-auto">
          <ErrorNotice error={importError} onDismiss={() => { setImportError(undefined); }} />
        </div>
      )}
      {captureError && (
        <div className="pointer-events-auto">
          <ErrorNotice error={captureError} onDismiss={() => { setCaptureError(undefined); }} />
        </div>
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

  const shownBitmap = loaded?.bitmap ?? emptyBitmap;

  return (
    <main className="flex min-w-0 flex-1 gap-1.5 p-1.5">
      <PanelDock open={sidebarOpen} side="left" width={SIDEBAR_WIDTH} keepMounted>
        <EditorSidebar
          history={history}
          edgeColor={loaded?.edge ?? null}
          removeBackground={removeBackground}
        />
      </PanelDock>
      <section className="relative flex min-w-0 flex-1 overflow-hidden rounded-2xl bg-canvas">
        {shownBitmap && (
          <ScenePreview
            scene={displayScene}
            bitmap={shownBitmap}
            bottomInset={showProperties ? 112 : 56}
            working={aiWorking}
            overlay={(geometry) => {
              if (loaded) return <AnnotationOverlay annotate={annotate} scene={displayScene} geometry={geometry} />;
              const rect = shotRectCss(displayScene, geometry);
              return (
                <EmptyCanvas
                  rect={rect}
                  radius={displayScene.frame.radius * (rect.w / displayScene.screenshot.width)}
                  dragging={dragging}
                  importing={importing}
                  shortcut={shortcut}
                  onOpenPicker={() => { setPickerOpen(true); }}
                  buttonRef={pickerAnchor}
                  onCapture={captureRegion}
                />
              );
            }}
          />
        )}
        <ImagePicker
          open={pickerOpen && !loaded && !dragging && !importing}
          anchor={pickerAnchor}
          onClose={closePicker}
          onFile={(file) => { void importFile(file); }}
          onError={setImportError}
        />
        {notices}
        {/* The properties float just above the toolbar, so the two read as one group. */}
        <div className="pointer-events-none absolute inset-x-3 bottom-[60px] z-10 flex justify-center">
          {showProperties && <AnnotationProperties annotate={annotate} />}
        </div>
        <AnnotationToolbar tool={annotate.tool} onTool={annotate.setTool} disabled={!hasImage} />
        {/* With an image open, a dragged file replaces it; without one, the card shows the drop. */}
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0 z-20 rounded-2xl ring-2 ring-inset ring-ring transition-opacity duration-150',
            dragging && hasImage ? 'opacity-100' : 'opacity-0',
          )}
        />
      </section>
      {/* Outside the panel, which may be hidden or on another tab when the question is asked. */}
      {removeBackground.dialog}
      <PanelDock open={chatOpen} side="right" width={CHAT_PANEL_WIDTH}>
        <ChatPanel chat={chat} onClose={() => { setChatPanelOpen(false); }} />
      </PanelDock>
    </main>
  );
}
