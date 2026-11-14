import { BUILTIN_IMAGES } from '@cropa/core';
import { AddIcon, Button, CloseIcon, ImageIcon, Tile, TileGroup } from '@cropa/ui';
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { commands, type BackgroundImage } from '../../lib/bindings.ts';
import { ErrorNotice } from '../../lib/ErrorNotice.tsx';
import {
  describeBackgroundImage,
  describeCommandError,
  describeUnexpected,
  type UserError,
} from '../../lib/errors.ts';
import {
  beginBackgroundChange,
  builtinUrl,
  cacheImage,
  ensureRefs,
} from './background-images.ts';
import { imageThumbnail } from './presets/thumbnails.ts';
import { backgroundImageRef, CAPTURE_REF, setBackgroundImage } from './scene-edits.ts';
import type { SceneHistory } from './use-scene-history.ts';

interface Props {
  history: Pick<SceneHistory, 'scene' | 'edit'>;
}

/** What Rust keeps and what the renderer draws without trouble. */
const MAX_FILE_MB = 20;
const MAX_SIDE = 8192;

const userRef = (id: string) => `user:${id}`;

/** The file as base64, without the `data:` prefix Rust does not expect. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => { reject(reader.error ?? new Error('could not read the file')); };
    reader.readAsDataURL(file);
  });
}

function UserThumb({ imageRef }: { imageRef: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let alive = true;
    void imageThumbnail(imageRef).then((next) => { if (alive) setUrl(next); });
    return () => { alive = false; };
  }, [imageRef]);
  return url ? (
    <img src={url} alt="" draggable={false} className="size-full object-cover" />
  ) : (
    <div className="size-full bg-secondary" />
  );
}

/** The picture choices of an image background: the screenshot, built-in images and the user's own. */
export function BackgroundImages({ history }: Props) {
  const { t } = useTranslation();
  const { scene, edit } = history;
  const [images, setImages] = useState<BackgroundImage[]>([]);
  const [error, setError] = useState<UserError>();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<BackgroundImage>();
  const fileInput = useRef<HTMLInputElement>(null);
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; });
  const current = backgroundImageRef(scene.background);

  /** Rust is the source of truth, so every change reloads the list. */
  const reload = useCallback(async () => {
    const result = await commands.listBackgroundImages();
    if (result.status === 'error') {
      setError(describeCommandError(tRef.current, result.error));
      return;
    }
    setImages(result.data);
  }, []);
  useEffect(() => {
    void reload().catch((cause: unknown) => { setError(describeUnexpected(tRef.current, cause)); });
  }, [reload]);

  const choose = async (ref: string) => {
    const isCurrent = beginBackgroundChange();
    // The renderer draws only images that are already loaded.
    const { missing } = await ensureRefs(ref === CAPTURE_REF ? [] : [ref]);
    if (!isCurrent()) return;
    if (missing.length > 0) {
      setError(describeBackgroundImage(t, { kind: 'BackgroundImageLoad' }));
      reload().catch((cause: unknown) => { setError(describeUnexpected(tRef.current, cause)); });
      return;
    }
    setError(undefined);
    edit((s) => setBackgroundImage(s, ref));
  };

  const addFile = async (file: File) => {
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setError(describeCommandError(t, { kind: 'BackgroundImageTooLarge', detail: MAX_FILE_MB }));
      return;
    }
    setBusy(true);
    // A picture that is not kept in the cache must be released.
    let bitmap: ImageBitmap | undefined;
    try {
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        setError(describeBackgroundImage(t, { kind: 'BackgroundImageUnreadable' }));
        return;
      }
      if (bitmap.width > MAX_SIDE || bitmap.height > MAX_SIDE) {
        setError(describeBackgroundImage(t, { kind: 'BackgroundImageDimensions', limit: MAX_SIDE }));
        return;
      }
      const isCurrent = beginBackgroundChange();
      const result = await commands.addBackgroundImage(file.name, await readBase64(file));
      if (result.status === 'error') {
        setError(describeCommandError(t, result.error));
        return;
      }
      const ref = userRef(result.data.id);
      cacheImage(ref, bitmap);
      bitmap = undefined;
      setError(undefined);
      // The image is stored whether or not the list can be refreshed, so select it either way.
      await reload().catch((cause: unknown) => { setError(describeUnexpected(t, cause)); });
      if (isCurrent()) edit((s) => setBackgroundImage(s, ref));
    } catch (cause) {
      setError(describeUnexpected(t, cause));
    } finally {
      bitmap?.close();
      setBusy(false);
    }
  };

  const confirmDelete = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!deleting || busy) return;
    setBusy(true);
    try {
      const result = await commands.deleteBackgroundImage(deleting.id);
      if (result.status === 'error') {
        setError(describeCommandError(t, result.error));
        return;
      }
      setError(undefined);
      setDeleting(undefined);
      await reload();
    } catch (cause) {
      setError(describeUnexpected(t, cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" role="group" aria-label={t('editor.background.images.label')}>
      {error && <ErrorNotice error={error} onDismiss={() => { setError(undefined); }} />}
      <TileGroup
        aria-label={t('editor.background.images.label')}
        value={current ?? undefined}
        onValueChange={(ref) => { void choose(ref); }}
      >
        <Tile value={CAPTURE_REF} label={t('editor.background.images.capture')}>
          <span className="text-muted-foreground">
            <ImageIcon className="size-5" />
          </span>
        </Tile>
        {BUILTIN_IMAGES.map((name) => {
          const ref = `builtin:${name}`;
          return (
            <Tile key={name} value={ref} label={t(`editor.background.images.names.${name}`)}>
              <img src={builtinUrl(name)} alt="" draggable={false} className="size-full object-cover" />
            </Tile>
          );
        })}
      </TileGroup>

      {images.length > 0 && (
        <>
          <h4 className="text-caption mt-1">{t('editor.background.images.yours')}</h4>
          <TileGroup
            aria-label={t('editor.background.images.yours')}
            value={current ?? undefined}
            onValueChange={(ref) => { void choose(ref); }}
          >
            {images.map((image) => (
              <Tile
                key={image.id}
                value={userRef(image.id)}
                label={image.name}
                overlay={
                  <Button
                    variant="secondary"
                    size="icon"
                    className="absolute top-2.5 right-2.5 size-5 bg-background/80 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                    aria-label={t('editor.background.images.more', { name: image.name })}
                    onClick={() => { setDeleting(image); }}
                  >
                    <CloseIcon />
                  </Button>
                }
              >
                <UserThumb imageRef={userRef(image.id)} />
              </Tile>
            ))}
          </TileGroup>
        </>
      )}

      <Button variant="secondary" className="w-full" disabled={busy} onClick={() => { fileInput.current?.click(); }}>
        <AddIcon className="size-4" />
        {t('editor.background.images.add')}
      </Button>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const input = event.target;
          const file = input.files?.[0];
          // Cleared so the same file can be picked again.
          input.value = '';
          if (file) void addFile(file);
        }}
      />

      {deleting && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => { void confirmDelete(event); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setDeleting(undefined);
            }
          }}
        >
          <p className="text-sm">{t('editor.background.images.deleteConfirm')}</p>
          <div className="flex gap-2">
            <Button type="submit" variant="destructive" disabled={busy}>
              {t('editor.background.images.delete')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => { setDeleting(undefined); }}>
              {t('editor.background.images.cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
