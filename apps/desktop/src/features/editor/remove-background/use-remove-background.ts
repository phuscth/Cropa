import { removeBackgroundTask, runTask } from '@cropa/ai';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { commands } from '../../../lib/bindings.ts';
import {
  describeCommandError,
  describeUnexpected,
  type UserError,
} from '../../../lib/errors.ts';
import { useAiAccess } from '../../ai/access.ts';
import { describeAiError } from '../../ai/errors.ts';
import { useImageConfirm } from '../../ai/ImageConfirmDialog.tsx';
import { capabilitiesOf, providerName, vendorName } from '../../ai/providers.ts';
import { createDesktopTransport } from '../../ai/transport.ts';
import { useDetection } from '../../ai/use-ai-providers.ts';
import { cacheImage, releaseMasksExcept } from '../background-images.ts';
import { dataUrlToBitmap } from '../load-image.ts';
import { maskName, maskRef, setMask } from '../scene-edits.ts';
import type { SceneHistory } from '../use-scene-history.ts';
import { describeCutoutError, describeSendProblem } from './errors.ts';
import {
  dataUrlBase64,
  dataUrlBytes,
  removeBackgroundLock,
  sendProblem,
  type LockReason,
} from './rules.ts';
import { canvasToPngDataUrl, pictureToSend } from './send-image.ts';
import { renderEnv } from '../render-env.ts';

const PROVIDER = 'codex';

interface Options {
  history: Pick<SceneHistory, 'scene' | 'edit'>;
  /** Names the image the editor shows (from Rust); null while it shows none. */
  imageKey: string | null;
  /** The image the editor shows, at full size. */
  bitmap: ImageBitmap | undefined;
}

/** Everything the background removal section shows and does. */
export interface RemoveBackgroundController {
  /** Why the button is off; null when it can run. */
  lock: LockReason | null;
  /** When the run in progress began (ms since the epoch); null when none is running. */
  startedAt: number | null;
  /** The screenshot is drawn as its cut-out. */
  masked: boolean;
  error: UserError | undefined;
  dismissError: () => void;
  run: () => void;
  cancel: () => void;
  /** Draws the whole screenshot again; one undo step. */
  restore: () => void;
  /** The confirmation dialog the run opens before the screenshot leaves the computer. */
  dialog: ReactNode;
}

/**
 * Background removal for the open image: one click sends the screenshot to Codex, turns its
 * answer into a cut-out in Rust and puts the cut-out in the scene as one undo step. A failure,
 * a refusal and a cancel leave the scene as it was.
 *
 * The cut-out the scene shows is also what the history keeps for the capture: whenever the
 * scene's mask changes (apply, restore, undo, redo) Rust is told which one is shown.
 */
export function useRemoveBackground({ history, imageKey, bitmap }: Options): RemoveBackgroundController {
  const { t } = useTranslation();
  const access = useAiAccess();
  const { listed } = useDetection();
  const codex = listed?.find((entry) => entry.provider === PROVIDER)?.detection;
  const { confirmImages, cancel: cancelConfirm, dialog } = useImageConfirm(
    access,
    providerName(t, PROVIDER),
    vendorName(t, PROVIDER),
    t('removeBackground.confirmNote'),
  );
  const { scene, edit } = history;
  const lock = removeBackgroundLock({
    hasImage: imageKey !== null,
    loading: listed === undefined || access.state === 'loading',
    codex,
    allowImages: access.allowImages,
  });

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<UserError>();
  const abort = useRef<AbortController | undefined>(undefined);
  const imageKeyNow = useRef(imageKey);
  const sceneNow = useRef(scene);
  const bitmapNow = useRef(bitmap);
  useEffect(() => {
    imageKeyNow.current = imageKey;
    sceneNow.current = scene;
    bitmapNow.current = bitmap;
  });

  // Cut-outs of earlier images are not needed again; this image's stay for undo, redo and export.
  useEffect(() => { releaseMasksExcept(imageKey); }, [imageKey]);

  // A new image ends the run for the old one: its answer would belong to a picture that is gone.
  useEffect(() => () => {
    abort.current?.abort();
    abort.current = undefined;
    cancelConfirm();
    setStartedAt(null);
    setError(undefined);
  }, [imageKey, cancelConfirm]);

  const run = useCallback(() => {
    if (abort.current || lock !== null) return;
    const controller = new AbortController();
    const { signal } = controller;
    // A function, so the checks after each await are not narrowed to "still running".
    const aborted = () => signal.aborted;
    abort.current = controller;
    setError(undefined);
    setStartedAt(Date.now());

    const work = async () => {
      const fetched = await commands.getEditorImage();
      if (aborted()) return;
      if (fetched.status === 'error') {
        setError(describeCommandError(t, fetched.error));
        return;
      }
      const data = fetched.data;
      const source = bitmapNow.current;
      if (!data || !source) return;
      // Checked before anything is sent: a run Rust would refuse afterwards still costs quota.
      const tooBig = sendProblem(source, null);
      if (tooBig) {
        setError(describeSendProblem(t, tooBig));
        return;
      }
      // Blur and pixelate boxes live only in the scene: what leaves the computer has them applied.
      const image = await pictureToSend(sceneNow.current, renderEnv(source), data.image, canvasToPngDataUrl);
      if (aborted()) return;
      const heavy = sendProblem(source, dataUrlBytes(image));
      if (heavy) {
        setError(describeSendProblem(t, heavy));
        return;
      }

      const outcome = await runTask(
        removeBackgroundTask,
        { image },
        {
          transport: createDesktopTransport({ provider: PROVIDER, model: null }),
          provider: { name: PROVIDER, capabilities: codex ? capabilitiesOf(codex) : [] },
          confirmImages,
          signal,
          effort: 'low',
        },
      ).done;
      if (aborted()) return;
      const cutout = outcome.result.cutout;
      if (outcome.source === 'fallback' || cutout === null) {
        const kind = outcome.notice?.kind ?? 'Protocol';
        // A cancel, or "don't send" in the dialog, is the user's own choice: no notice.
        if (kind !== 'Cancelled') setError(describeAiError(t, kind, providerName(t, PROVIDER)));
        return;
      }

      const applied = await commands.applyCutout(data.imageKey, dataUrlBase64(cutout));
      if (aborted()) return;
      if (applied.status === 'error') {
        const notice = describeCutoutError(t, applied.error);
        if (notice) setError(notice);
        return;
      }
      const bitmap = await dataUrlToBitmap(applied.data.image);
      if (aborted() || imageKeyNow.current !== data.imageKey) {
        bitmap.close();
        return;
      }
      // The renderer asks for the cut-out synchronously, so it is cached before the scene names it.
      cacheImage(maskRef(applied.data.name), bitmap);
      edit((s) => setMask(s, applied.data.name));
    };

    void work()
      .catch((cause: unknown) => {
        if (!aborted()) setError(describeUnexpected(t, cause));
      })
      .finally(() => {
        if (abort.current === controller) {
          abort.current = undefined;
          setStartedAt(null);
        }
      });
  }, [lock, t, codex, confirmImages, edit]);

  const cancel = useCallback(() => {
    abort.current?.abort();
    cancelConfirm();
    abort.current = undefined;
    setStartedAt(null);
  }, [cancelConfirm]);

  const restore = useCallback(() => { edit((s) => setMask(s, null)); }, [edit]);

  // Keeps what the history holds in step with the scene, whatever changed it. The first scene of
  // an image is what the history already has, so only later changes are sent.
  const shownName = maskName(scene);
  const reported = useRef<{ key: string | null; name: string | null }>({ key: null, name: null });
  const queue = useRef<{ tail: Promise<void>; latest: number }>({ tail: Promise.resolve(), latest: 0 });
  useEffect(() => {
    if (imageKey === null) {
      reported.current = { key: null, name: null };
      return;
    }
    if (reported.current.key !== imageKey) {
      reported.current = { key: imageKey, name: shownName };
      return;
    }
    if (reported.current.name === shownName) return;
    reported.current = { key: imageKey, name: shownName };
    // One call at a time, and only the newest state matters: a call started later could finish
    // first on its own thread and leave the history out of step with the scene.
    const mine = ++queue.current.latest;
    queue.current.tail = queue.current.tail.then(async () => {
      if (mine !== queue.current.latest) return;
      try {
        const result = await commands.showCutout(imageKey, shownName);
        if (result.status !== 'error') return;
        const notice = describeCutoutError(t, result.error);
        if (notice) setError(notice);
      } catch (cause) {
        setError(describeUnexpected(t, cause));
      }
    });
  }, [imageKey, shownName, t]);

  return {
    lock,
    startedAt,
    masked: shownName !== null,
    error,
    dismissError: () => { setError(undefined); },
    run,
    cancel,
    restore,
    dialog,
  };
}
