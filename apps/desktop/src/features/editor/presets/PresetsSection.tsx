import {
  builtinPresets,
  exportPreset,
  importPreset,
  PRESET_MAX_BYTES,
  presetId,
  presetName,
  withoutCodeLayers,
  type BackgroundSpec,
  type Preset,
} from '@cropa/core';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Tile,
  TileGroup,
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
  onUserPresetsChanged,
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
import { registerPresetExport } from '../../shell/editor-actions.ts';
import { Section } from '../Section.tsx';
import type { SceneHistory } from '../use-scene-history.ts';
import { isAiPreset, presetFileProblem } from './preset-file.ts';
import { presetThumbnail } from './thumbnails.ts';

/** The anchor of the presets section, which the editor panel's preset card scrolls to. */
export const PRESETS_SECTION_ID = 'editor-presets';

interface Props {
  history: Pick<SceneHistory, 'scene' | 'edit'>;
  /** Called before a preset file is exported, so the status line is on screen. */
  onExport?: () => void;
  /** Reports the name of the preset the background matches, or undefined when it matches none. */
  onCurrent?: (name: string | undefined) => void;
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
export function PresetThumb({ background }: { background: BackgroundSpec }) {
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
    <img src={url} alt="" draggable={false} className="size-full object-cover" />
  ) : (
    <div className="size-full bg-secondary" />
  );
}

interface PresetTileProps {
  value: string;
  name: string;
  background: BackgroundSpec;
  /** An item laid over the tile, such as its menu. */
  menu?: ReactNode;
  /** A selector for the end-to-end tests that does not depend on the language. */
  testId?: string;
}

function PresetTile({ value, name, background, menu, testId }: PresetTileProps) {
  const { t } = useTranslation();
  const label = isAiPreset(background) ? t('editor.presets.aiName', { name }) : name;
  return (
    <Tile
      value={value}
      label={label}
      data-testid={testId}
      overlay={
        <>
          {isAiPreset(background) && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-2.5 left-2.5 rounded bg-background/80 px-1 text-[10px] leading-4 font-medium"
            >
              {t('editor.presets.aiBadge')}
            </span>
          )}
          {menu}
        </>
      }
    >
      <PresetThumb background={background} />
    </Tile>
  );
}

export function PresetsSection({ history, onExport, onCurrent }: Props) {
  const { t, i18n } = useTranslation();
  const { scene, edit } = history;
  const [library, setLibrary] = useState<Library>({ presets: [], unreadable: [] });
  const [mode, setMode] = useState<Mode>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserError>();
  const [status, setStatus] = useState<string>();
  // A preset that needs the development code stub, so it is only loaded in development.
  const [devPresets, setDevPresets] = useState<Preset[]>([]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    void import('../dev-code-stub.ts').then(({ devCodePreset }) => { setDevPresets([devCodePreset]); });
  }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const statusTimer = useRef<number>(undefined);
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; });
  useEffect(() => () => { window.clearTimeout(statusTimer.current); }, []);

  /** Rust is the source of truth, so every change reloads the list (see `onUserPresetsChanged`). */
  const reload = useCallback(async () => {
    const result = await listUserPresets();
    if (result.status === 'error') {
      setError(describeCommandError(tRef.current, result.error));
      return;
    }
    setLibrary(result.data);
  }, []);
  useEffect(() => {
    const load = () => {
      void reload().catch((cause: unknown) => { setError(describeUnexpected(tRef.current, cause)); });
    };
    load();
    // A preset saved or deleted anywhere in this window, such as from the AI background section.
    return onUserPresetsChanged(load);
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
      if (done !== undefined) close();
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
    if (saved) close();
  };

  const showStatus = (text: string) => {
    window.clearTimeout(statusTimer.current);
    setStatus(text);
    statusTimer.current = window.setTimeout(() => { setStatus(undefined); }, STATUS_MS);
  };

  const exportFile = async (preset: { name: string; background: BackgroundSpec }) => {
    // A file cannot carry a code layer, so it gets the layers under it.
    const fileSpec = withoutCodeLayers(preset.background);
    if (!fileSpec) {
      setError(describePresetFile(t, { kind: 'PresetExportOnlyCode' }));
      return;
    }
    const droppedCode = fileSpec.layers.length < preset.background.layers.length;
    const text = exportPreset(fileSpec, {
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
      const ownImage = backgroundImageRefs(fileSpec).some((ref) => ref.startsWith('user:'));
      const key = droppedCode
        ? ownImage
          ? 'editor.presets.exportedWithoutCodeWithImage'
          : 'editor.presets.exportedWithoutCode'
        : ownImage
          ? 'editor.presets.exportedWithImage'
          : 'editor.presets.exported';
      showStatus(t(key, { fileName }));
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
  const builtins = [...builtinPresets, ...devPresets];
  const selectedBuiltin = builtins.find((preset) => sameBackground(scene.background, preset.background));
  const selectedSaved = library.presets.find((preset) => sameBackground(scene.background, preset.background));

  const currentName = selectedBuiltin
    ? presetName(selectedBuiltin, i18n.language)
    : selectedSaved?.name;
  useEffect(() => { onCurrent?.(currentName); }, [currentName, onCurrent]);

  // The File menu exports the background on screen, under the name of the preset it matches.
  const exportCurrent = () => {
    onExport?.();
    const name = selectedBuiltin
      ? presetName(selectedBuiltin, i18n.language)
      : (selectedSaved?.name ?? t('editor.presets.currentName'));
    void exportFile({ name, background: scene.background });
  };
  const exportCurrentRef = useRef(exportCurrent);
  useEffect(() => { exportCurrentRef.current = exportCurrent; });
  useEffect(() => registerPresetExport(() => { exportCurrentRef.current(); }), []);

  return (
    <Section
      id={PRESETS_SECTION_ID}
      title={t('editor.presets.title')}
      actions={
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('editor.presets.saveCurrent')}
            title={t('editor.presets.saveCurrent')}
            disabled={busy}
            onClick={() => { open({ kind: 'save' }); }}
          >
            <PlusIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
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

      <TileGroup
        aria-label={t('editor.presets.title')}
        value={selectedBuiltin?.id}
        onValueChange={(id) => {
          const preset = builtins.find((candidate) => candidate.id === id);
          if (preset) void apply(preset.background);
        }}
      >
        {builtins.map((preset) => (
          <PresetTile
            key={preset.id}
            value={preset.id}
            name={presetName(preset, i18n.language)}
            background={preset.background}
            testId={`preset-${preset.id}`}
          />
        ))}
      </TileGroup>

      <h4 className="text-caption mt-1">{t('editor.presets.saved')}</h4>
      {library.presets.length === 0 && library.unreadable.length === 0 && (
        <p className="text-caption">{t('editor.presets.empty')}</p>
      )}
      {library.presets.length > 0 && (
        <TileGroup
          aria-label={t('editor.presets.saved')}
          value={selectedSaved?.id}
          onValueChange={(id) => {
            const preset = library.presets.find((candidate) => candidate.id === id);
            if (preset) void apply(preset.background);
          }}
        >
          {library.presets.map((preset) => (
            <PresetTile
              key={preset.id}
              value={preset.id}
              name={preset.name}
              background={preset.background}
              menu={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="secondary"
                      size="icon"
                      className="absolute top-2.5 right-2.5 size-5 bg-background/80 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
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
        </TileGroup>
      )}
      {library.unreadable.map((entry) => (
        <div key={entry.id} className="text-caption flex items-center justify-between gap-2">
          <span className="min-w-0 truncate">{t('editor.presets.unreadable', { name: entry.name })}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              void run(() => deleteUserPreset(entry.id));
            }}
          >
            {t('editor.presets.delete')}
          </Button>
        </div>
      ))}

      {status && <p className="text-caption">{status}</p>}

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
            <p className="text-control-sm">{t('editor.presets.deleteConfirm', { name: mode.preset.name })}</p>
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
