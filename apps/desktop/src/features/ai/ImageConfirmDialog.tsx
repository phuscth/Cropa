import { Button } from '@cropa/ui';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { AiAccess } from './access.ts';

interface DialogProps {
  /** Number of images waiting for an answer; `undefined` keeps the dialog closed. */
  imageCount: number | undefined;
  allowImages: boolean;
  providerName: string;
  vendorName: string;
  onAnswer: (send: boolean) => void;
}

/**
 * Asks before screenshots leave the computer. When sending images is off in
 * Settings it only explains where to turn it on.
 */
export function ImageConfirmDialog({
  imageCount,
  allowImages,
  providerName,
  vendorName,
  onAnswer,
}: DialogProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (imageCount !== undefined && !dialog.open) dialog.showModal();
    if (imageCount === undefined && dialog.open) dialog.close();
  }, [imageCount]);

  const vars = { count: imageCount ?? 0, provider: providerName, vendor: vendorName };
  return (
    <dialog
      ref={ref}
      aria-labelledby="image-confirm-title"
      className="m-auto max-w-sm rounded-xl bg-popover p-6 text-popover-foreground shadow-xl backdrop:bg-black/40"
      // Esc and any other way of closing it count as "don't send".
      onClose={() => { onAnswer(false); }}
    >
      <div className="flex flex-col gap-4 text-sm">
        <h2 id="image-confirm-title" className="text-heading">
          {allowImages ? t('ai.imageConfirm.title', vars) : t('ai.imageConfirm.offTitle')}
        </h2>
        <p className="text-muted-foreground">
          {allowImages ? t('ai.imageConfirm.body', vars) : t('ai.imageConfirm.offBody')}
        </p>
        <div className="flex justify-end gap-2">
          {allowImages ? (
            <>
              <Button variant="outline" onClick={() => { onAnswer(false); }}>
                {t('ai.imageConfirm.dontSend')}
              </Button>
              <Button onClick={() => { onAnswer(true); }}>
                {t('ai.imageConfirm.send')}
              </Button>
            </>
          ) : (
            <Button onClick={() => { onAnswer(false); }}>
              {t('ai.imageConfirm.close')}
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}

/**
 * `confirmImages` for `runTask`, and the dialog to render. A run is never
 * told to send images when sending is off in Settings.
 */
export function useImageConfirm(
  access: AiAccess,
  providerName: string,
  vendorName: string,
): {
  confirmImages: (images: readonly string[]) => Promise<boolean>;
  /** Closes the dialog and answers "don't send"; call it when the run is aborted. */
  cancel: () => void;
  dialog: ReactNode;
} {
  const [imageCount, setImageCount] = useState<number>();
  const resolver = useRef<((send: boolean) => void) | undefined>(undefined);

  const confirmImages = useCallback(
    (images: readonly string[]) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setImageCount(images.length);
      }),
    [],
  );

  const cancel = useCallback(() => {
    resolver.current?.(false);
    resolver.current = undefined;
    setImageCount(undefined);
  }, []);

  // A question still open when the window goes away is answered "don't send".
  useEffect(() => () => { resolver.current?.(false); }, []);

  const answer = (send: boolean) => {
    // Closing the dialog fires another answer; only the first one counts.
    resolver.current?.(send && access.allowImages);
    resolver.current = undefined;
    setImageCount(undefined);
  };

  const dialog = (
    <ImageConfirmDialog
      imageCount={imageCount}
      allowImages={access.allowImages}
      providerName={providerName}
      vendorName={vendorName}
      onAnswer={answer}
    />
  );
  return { confirmImages, cancel, dialog };
}
