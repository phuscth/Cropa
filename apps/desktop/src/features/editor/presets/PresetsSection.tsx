import {
  builtinPresets,
  exportPreset,
  importPreset,
  PRESET_MAX_BYTES,
  presetId,
  presetName,
  type BackgroundSpec,
} from '@cropa/core';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from '@cropa/ui';
import { useCallback, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { commands } from '../../../lib/bindings.ts';
import { ErrorNotice } from '../../../lib/ErrorNotice.tsx';
import {
  describeCommandError,
  describePresetFile,
  describeUnexpected,
  type UserError,
} from '../../../lib/errors.ts';
import {
  deleteUserPreset,
  listUserPresets,
  saveUserPreset,
  type Result,
  type SavedPreset,
} from '../../../lib/user-presets.ts';
import { beginBackgroundChange, ensureImages } from '../background-images.ts';
import {
  applyBackground,
  backgroundImageRefs,
  sameBackground,
  withoutMissingImages,
} from '../scene-edits.ts';
import { Section } from '../Section.tsx';
import type { SceneHistory } from '../use-scene-history.ts';
import { presetFileProblem } from './preset-file.ts';
import { presetThumbnail } from './thumbnails.ts';

interface Props {
  history: Pick<SceneHistory, 'scene' | 'edit'>;
}

type Mode =
  | { kind: 'save' }
  | { kind: 'rename'; preset: SavedPreset }
  | { kind: 'delete'; preset: SavedPreset };

interface Library {
  presets: SavedPreset[];
  unreadable: { id: string; name: string }[];
}

const NAME_MAX = 40;
const STATUS_MS = 6000;

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 10.5v-7M5 6l3-3 3 3" />
      <path d="M3 10.5v2h10v-2" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}

/** A preview of a background; a neutral box until it is drawn. */
function PresetThumb({ background }: { background: BackgroundSpec }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let alive = true;
    void presetThumbnail(background).then(
      (next) => { if (alive) setUrl(next); },
      () => undefined,
    );
    return () => { alive = false; };
  }, [background]);
  return url ? (
    <img src={url} alt="" draggable={false} className="h-12 w-16 rounded-md object-cover" />
  ) : (
    <div className="h-12 w-16 rounded-md bg-secondary" />
  );
}

interface TileProps {
  name: string;
  background: BackgroundSpec;
  selected: boolean;
  onSelect: () => void;
  menu?: ReactNode;
  /** A selector for the end-to-end tests that does not depend on the language. */
  testId?: string;
}

function Tile({ name, background, selected, onSelect, menu, testId }: TileProps) {
  return (
    <div className="group relative">
      <button
        type="button"
        data-testid={testId}
        aria-label={name}
        title={name}
        aria-pressed={selected}
        onClick={onSelect}
        className={`block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          selected ? 'ring-2 ring-primary' : 'hover:ring-2 hover:ring-border'
        }`}
      >
        <PresetThumb background={background} />
      </button>
      {menu}
    </div>
  );
}

export function PresetsSection({ history }: Props) {
  const { t, i18n } = useTranslation();
  const { scene, edit } = history;
  const [library, setLibrary] = useState<Library>({ presets: [], unreadable: [] });
  const [mode, setMode] = useState<Mode>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserError>();
  const [status, setStatus] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const statusTimer = useRef<number>(undefined);
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; });
  useEffect(() => () => { window.clearTimeout(statusTimer.current); }, []);

  /** Rust is the source of truth, so every change reloads the list. */
  const reload = useCallback(async () => {
    const result = await listUserPresets();
    if (result.status === 'error') {
      setError(describeCommandError(tRef.current, result.error));
      return;
    }
    setLibrary(result.data);
  }, []);
  useEffect(() => {
    void reload().catch((cause: unknown) => { setError(describeUnexpected(tRef.current, cause)); });
  }, [reload]);

  /** Runs a command with the buttons disabled; shows its error, and tells whether it worked. */
  const run = async <T,>(job: () => Promise<Result<T>>): Promise<T | undefined> => {
    setBusy(true);
    try {
      const result = await job();
      if (result.status === 'error') {
        setError(describeCommandError(t, result.error));
        return undefined;
      }
      setError(undefined);
      return result.data;
    } catch (cause) {
      setError(describeUnexpected(t, cause));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const open = (next: Mode) => {
    setMode(next);
    setName(next.kind === 'rename' ? next.preset.name : '');
  };
  const close = () => { setMode(undefined); };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!mode || busy) return;
    if (mode.kind === 'delete') {
      const done = await run(() => deleteUserPreset(mode.preset.id));
      if (done !== undefined) {
        close();
        await reload();
      }
      return;
    }
    const trimmed = name.trim();
    if (trimmed === '') return;
    const saved = await run(() =>
      saveUserPreset(
        mode.kind === 'rename'
          ? { id: mode.preset.id, name: trimmed, background: mode.preset.background }
          : { name: trimmed, background: scene.background },
      ),
    );
    if (saved) {
      close();
      await reload();
    }
  };

  const showStatus = (text: string) => {
    window.clearTimeout(statusTimer.current);
    setStatus(text);
    statusTimer.current = window.setTimeout(() => { setStatus(undefined); }, STATUS_MS);
  };

  const exportFile = async (preset: SavedPreset) => {
    const text = exportPreset(preset.background, {
      id: presetId(preset.name),
      name: { en: preset.name },
    });
    if (!text.ok) {
      setError(describePresetFile(t, presetFileProblem(text.error)));
      return;
    }
    const fileName = await run(() => commands.savePresetFile(preset.name, text.value));
    if (typeof fileName === 'string') {
      // A user image stays on this computer, so the file alone can't bring it along.
      const ownImage = backgroundImageRefs(preset.background).some((ref) => ref.startsWith('user:'));
      showStatus(t(ownImage ? 'editor.presets.exportedWithImage' : 'editor.presets.exported', { fileName }));
    }
  };

  const importFile = async (file: File) => {
    if (file.size > PRESET_MAX_BYTES) {
      setError(
        describePresetFile(
          t,
          presetFileProblem({ kind: 'too-large', bytes: file.size, limit: PRESET_MAX_BYTES }),
        ),
      );
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch (cause) {
      setError(describeUnexpected(t, cause));
      return;
    }
    const parsed = importPreset(text);
    if (!parsed.ok) {
      setError(describePresetFile(t, presetFileProblem(parsed.error)));
      return;
    }
    const saved = await run(() =>
      saveUserPreset({
        name: presetName(parsed.value, i18n.language),
        background: parsed.value.background,
      }),
    );
    if (saved) {
      await reload();
      const { missing } = await ensureImages(parsed.value.background);
      if (missing.length > 0) showStatus(t('editor.presets.imageMissing'));
    }
  };

  /** Loads the images the background draws first: the renderer only draws what is loaded. */
  const apply = async (background: BackgroundSpec) => {
    const isCurrent = beginBackgroundChange();
    const { missing } = await ensureImages(background);
    if (!isCurrent()) return;
    edit((s) => applyBackground(s, withoutMissingImages(background, missing)));
    if (missing.length > 0) showStatus(t('editor.presets.imageMissing'));
  };
  const select = (background: BackgroundSpec) => () => {
    void apply(background);
  };

  return (
    <Section
      title={t('editor.presets.title')}
      actions={
        <>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t('editor.presets.saveCurrent')}
            title={t('editor.presets.saveCurrent')}
            disabled={busy}
            onClick={() => { open({ kind: 'save' }); }}
          >
            <PlusIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t('editor.presets.import')}
            title={t('editor.presets.import')}
            disabled={busy}
            onClick={() => { fileInput.current?.click(); }}
          >
            <UploadIcon />
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              const input = event.target;
              const file = input.files?.[0];
              // Cleared so the same file can be picked again.
              input.value = '';
              if (file) void importFile(file);
            }}
          />
        </>
      }
    >
      {error && <ErrorNotice error={error} onDismiss={() => { setError(undefined); }} />}

      <div className="grid grid-cols-4 gap-2">
        {builtinPresets.map((preset) => {
          const label = presetName(preset, i18n.language);
          return (
            <Tile
              key={preset.id}
              name={label}
              background={preset.background}
              selected={sameBackground(scene.background, preset.background)}
              onSelect={select(preset.background)}
              testId={`preset-${preset.id}`}
            />
          );
        })}
      </div>

      <h4 className="text-xs text-muted-foreground">{t('editor.presets.saved')}</h4>
      {library.presets.length === 0 && library.unreadable.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('editor.presets.empty')}</p>
      )}
      {library.presets.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {library.presets.map((preset) => (
            <Tile
              key={preset.id}
              name={preset.name}
              background={preset.background}
              selected={sameBackground(scene.background, preset.background)}
              onSelect={select(preset.background)}
              menu={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="secondary"
                      size="icon"
                      className="absolute top-0.5 right-0.5 size-5 bg-background/80 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                      aria-label={t('editor.presets.more', { name: preset.name })}
                    >
                      <DotsIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onSelect={() => { open({ kind: 'rename', preset }); }}>
                      {t('editor.presets.rename')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => { void exportFile(preset); }}>
                      {t('editor.presets.export')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => { open({ kind: 'delete', preset }); }}
                    >
                      {t('editor.presets.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            />
          ))}
        </div>
      )}
      {library.unreadable.map((entry) => (
        <div key={entry.id} className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span className="min-w-0 truncate">{t('editor.presets.unreadable', { name: entry.name })}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              void run(() => deleteUserPreset(entry.id)).then(() => reload());
            }}
          >
            {t('editor.presets.delete')}
          </Button>
        </div>
      ))}

      {status && <p className="text-sm text-muted-foreground">{status}</p>}

      {mode && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => { void submit(event); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
        >
          {mode.kind === 'delete' ? (
            <p className="text-sm">{t('editor.presets.deleteConfirm', { name: mode.preset.name })}</p>
          ) : (
            <Input
              autoFocus
              maxLength={NAME_MAX}
              aria-label={t('editor.presets.name')}
              placeholder={t('editor.presets.name')}
              value={name}
              onChange={(event) => { setName(event.target.value); }}
            />
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              variant={mode.kind === 'delete' ? 'destructive' : 'default'}
              disabled={busy || (mode.kind !== 'delete' && name.trim() === '')}
            >
              {mode.kind === 'delete' ? t('editor.presets.delete') : t('editor.presets.save')}
            </Button>
            <Button type="button" variant="ghost" onClick={close}>
              {t('editor.presets.cancel')}
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}
