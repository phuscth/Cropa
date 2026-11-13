import type { Scene } from '@cropa/core';
import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, type CommandError, type ExportFormat, type SavedFile } from '../../../lib/bindings.ts';
import {
  describeCodeLayerSkipped,
  describeCommandError,
  describeExport,
  describeExportImageChanged,
  describeUnexpected,
  type UserError,
} from '../../../lib/errors.ts';
import { renderImage } from './encode.ts';
import { captureFileStem, type ExportScale } from './plan.ts';
import { afterQuickSave, initialSessionFile, sessionFileFor } from './session-file.ts';

export type ExportNotice = { kind: 'saved'; file: SavedFile } | { kind: 'copied' } | { kind: 'dragHint' };

interface Args {
  scene: Scene;
  bitmap: ImageBitmap | undefined;
  /** Counts the images the editor has loaded; a new image starts a new quick-save file. */
  imageId: number;
  /** When the image was captured, in ms since the epoch; null when unknown. */
  capturedAt: number | null;
}

const NOTICE_MS = 6000;

/** How far the pointer moves, in CSS px, before a press on the handle becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

interface DragStart {
  x: number;
  y: number;
  /** The image and capture time at the press; the drag must still be of this image. */
  imageId: number;
  capturedAt: number | null;
  /** The 1x PNG, rendering since the press so it is usually ready when the drag starts. */
  pending: Promise<string | undefined>;
}

type Result<T> = { status: 'ok'; data: T } | { status: 'error'; error: CommandError };

export function useExport({ scene, bitmap, imageId, capturedAt }: Args) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ExportNotice>();
  const [error, setError] = useState<UserError>();
  // The export went ahead without something; shown next to errors, cleared by the next export.
  const [warning, setWarning] = useState<UserError>();

  // The latest values, so the keyboard handler and the actions stay stable across edits.
  const latest = useRef({ scene, bitmap, imageId, capturedAt, t });
  useEffect(() => { latest.current = { scene, bitmap, imageId, capturedAt, t }; });
  const running = useRef(false);
  const sessionFile = useRef(initialSessionFile(imageId));
  const timer = useRef<number>(undefined);
  const dragStart = useRef<DragStart>(undefined);

  const dismissNotice = useCallback(() => {
    window.clearTimeout(timer.current);
    setNotice(undefined);
  }, []);
  const dismissError = useCallback(() => { setError(undefined); }, []);
  const dismissWarning = useCallback(() => { setWarning(undefined); }, []);
  useEffect(() => () => { window.clearTimeout(timer.current); }, []);

  const show = useCallback((next: ExportNotice) => {
    window.clearTimeout(timer.current);
    setNotice(next);
    timer.current = window.setTimeout(() => { setNotice(undefined); }, NOTICE_MS);
  }, []);

  /** Runs one export at a time; a second call while one runs is ignored. */
  const run = useCallback(
    async (job: (current: typeof latest.current & { bitmap: ImageBitmap }) => Promise<void>) => {
      const current = latest.current;
      if (running.current || !current.bitmap) return;
      running.current = true;
      setBusy(true);
      setWarning(undefined);
      try {
        await job({ ...current, bitmap: current.bitmap });
      } catch (cause) {
        setError(describeUnexpected(latest.current.t, cause));
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [],
  );

  const render = useCallback(
    async (
      current: { scene: Scene; bitmap: ImageBitmap; t: typeof t },
      format: ExportFormat,
      scale: ExportScale,
    ): Promise<string | undefined> => {
      try {
        const image = await renderImage(current.scene, current.bitmap, format, scale);
        if (image.codeLayerFailed) setWarning(describeCodeLayerSkipped(current.t));
        return image.dataUrl;
      } catch (cause) {
        setError(describeExport(current.t, cause));
        return undefined;
      }
    },
    [],
  );

  /** Shows a command's error, or hands its data back. */
  const unwrap = useCallback(<T,>(result: Result<T>): T | undefined => {
    if (result.status === 'error') {
      setError(describeCommandError(latest.current.t, result.error));
      return undefined;
    }
    setError(undefined);
    return result.data;
  }, []);

  const quickSave = useCallback(
    () =>
      run(async (current) => {
        const dataUrl = await render(current, 'png', 2);
        if (dataUrl === undefined) return;
        const outcome = unwrap(
          await commands.quickSave(
            dataUrl,
            'png',
            current.capturedAt,
            sessionFileFor(sessionFile.current, current.imageId),
          ),
        );
        if (!outcome) return;
        sessionFile.current = afterQuickSave(sessionFile.current, current.imageId, outcome);
        if (outcome.kind === 'saved') show({ kind: 'saved', file: outcome.file });
      }),
    [run, render, unwrap, show],
  );

  const saveAs = useCallback(
    (format: ExportFormat, scale: ExportScale) =>
      run(async (current) => {
        // The dialog comes first so it appears before the image is rendered.
        const choice = unwrap(
          await commands.chooseSaveAsPath(captureFileStem(current.capturedAt ?? Date.now()), format),
        );
        if (choice?.kind !== 'chosen') return;
        // A new capture can replace the image while the dialog is open.
        if (latest.current.imageId !== current.imageId) {
          setError(describeExportImageChanged(current.t));
          return;
        }
        // The user can change the file type in the dialog; encode what they chose.
        const dataUrl = await render(current, choice.format, scale);
        if (dataUrl === undefined) return;
        const file = unwrap(await commands.writeSaveAs(choice.token, dataUrl));
        if (file) show({ kind: 'saved', file });
      }),
    [run, render, unwrap, show],
  );

  const copy = useCallback(
    () =>
      run(async (current) => {
        // 1x, the size of the capture: a 2x image is too heavy to paste into a chat.
        const dataUrl = await render(current, 'png', 1);
        if (dataUrl === undefined) return;
        if (unwrap(await commands.copyRenderedImage(dataUrl)) !== undefined) show({ kind: 'copied' });
      }),
    [run, render, unwrap, show],
  );

  const onDragPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const current = latest.current;
      if (event.button !== 0 || running.current || !current.bitmap) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStart.current = {
        x: event.clientX,
        y: event.clientY,
        imageId: current.imageId,
        capturedAt: current.capturedAt,
        pending: render({ ...current, bitmap: current.bitmap }, 'png', 1),
      };
    },
    [render],
  );

  const onDragPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = dragStart.current;
      if (!start) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= DRAG_THRESHOLD_PX) return;
      // Fire once; the operating system's drag takes over the mouse from here.
      dragStart.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      void run(async (current) => {
        const dataUrl = await start.pending;
        if (dataUrl === undefined) return;
        // A new capture can replace the image during the press.
        if (latest.current.imageId !== start.imageId) {
          setError(describeExportImageChanged(current.t));
          return;
        }
        const result = unwrap(await commands.startDrag(dataUrl, start.capturedAt));
        // Released before the drag began: tell the user how it works.
        if (result === 'notStarted') show({ kind: 'dragHint' });
      });
    },
    [run, unwrap, show],
  );

  /** A press that ended before it moved far enough is not a drag. */
  const onDragPointerEnd = useCallback(() => {
    dragStart.current = undefined;
  }, []);

  const reveal = useCallback(
    async (fileId: number) => {
      try {
        unwrap(await commands.revealSavedFile(fileId));
      } catch (cause) {
        setError(describeUnexpected(latest.current.t, cause));
      }
    },
    [unwrap],
  );

  const dragHandlers = {
    onPointerDown: onDragPointerDown,
    onPointerMove: onDragPointerMove,
    onPointerUp: onDragPointerEnd,
    onPointerCancel: onDragPointerEnd,
    onLostPointerCapture: onDragPointerEnd,
  };

  return { busy, notice, error, warning, dismissWarning, quickSave, saveAs, copy, reveal, dragHandlers, dismissNotice, dismissError };
}
