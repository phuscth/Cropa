import { BUILTIN_IMAGES } from '@cropa/core';
import { Button } from '@cropa/ui';
import { useCallback, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
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
  imageTile,
} from './background-images.ts';
import { backgroundImageRef, CAPTURE_REF, setBackgroundImage } from './scene-edits.ts';
import type { SceneHistory } from './use-scene-history.ts';

interface Props {
  history: Pick<SceneHistory, 'scene' | 'edit'>;
}

/** What Rust keeps and what the renderer draws without trouble. */
const MAX_FILE_MB = 20;
const MAX_SIDE = 8192;

const userRef = (id: string) => `user:${id}`;

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" className="size-4">
      <path d="M8 3.5v9M3.5 8h9" />
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

function ScreenshotIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true" className="size-5">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 10.5 5.5 7 9 10.5l2-2 3 3" />
    </svg>
  );
}

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
    void imageTile(imageRef).then((next) => { if (alive) setUrl(next); });
    return () => { alive = false; };
  }, [imageRef]);
  return url ? (
    <img src={url} alt="" draggable={false} className="h-12 w-16 rounded-md object-cover" />
  ) : (
    <div className="h-12 w-16 rounded-md bg-secondary" />
  );
}

interface TileProps {
  name: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
  action?: ReactNode;
}

function Tile({ name, selected, onSelect, children, action }: TileProps) {
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={name}
        title={name}
        aria-pressed={selected}
        onClick={onSelect}
        className={`block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          selected ? 'ring-2 ring-primary' : 'hover:ring-2 hover:ring-border'
        }`}
      >
        {children}
      </button>
      {action}
    </div>
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
      <div className="grid grid-cols-4 gap-2">
        <Tile
          name={t('editor.background.images.capture')}
          selected={current === CAPTURE_REF}
          onSelect={() => { void choose(CAPTURE_REF); }}
        >
          <div className="flex h-12 w-16 items-center justify-center rounded-md bg-secondary text-muted-foreground">
            <ScreenshotIcon />
          </div>
        </Tile>
        {BUILTIN_IMAGES.map((name) => {
          const ref = `builtin:${name}`;
          return (
            <Tile
              key={name}
              name={t(`editor.background.images.names.${name}`)}
              selected={current === ref}
              onSelect={() => { void choose(ref); }}
            >
              <img
                src={builtinUrl(name)}
                alt=""
                draggable={false}
                className="h-12 w-16 rounded-md bg-secondary object-cover"
              />
            </Tile>
          );
        })}
      </div>

      {images.length > 0 && (
        <>
          <h4 className="text-xs text-muted-foreground">{t('editor.background.images.yours')}</h4>
          <div className="grid grid-cols-4 gap-2">
            {images.map((image) => (
              <Tile
                key={image.id}
                name={image.name}
                selected={current === userRef(image.id)}
                onSelect={() => { void choose(userRef(image.id)); }}
                action={
                  <Button
                    variant="secondary"
                    size="icon"
                    className="absolute top-0.5 right-0.5 size-5 bg-background/80 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
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
          </div>
        </>
      )}

      <Button variant="outline" disabled={busy} onClick={() => { fileInput.current?.click(); }}>
        <PlusIcon />
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
