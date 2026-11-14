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
  AddIcon,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  MoreIcon,
  PickerCard,
  PickerContent,
  PickerGrid,
  PickerPill,
  PickerPills,
  PickerRow,
  PickerSection,
  Popover,
  PopoverTrigger,
  SelectorCard,
  UploadIcon,
} from '@cropa/ui';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type SyntheticEvent,
} from 'react';
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
  backgroundKind,
  sameBackground,
  withoutMissingImages,
} from '../scene-edits.ts';
import type { SceneHistory } from '../use-scene-history.ts';
import { imagePresets } from './image-presets.ts';
import {
  isAiPreset,
  PRESET_CATEGORIES,
  presetCategory,
  presetFileProblem,
  type PresetCategory,
} from './preset-file.ts';
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

/** One card of the picker. */
interface Entry {
  id: string;
  name: string;
  background: BackgroundSpec;
  category: PresetCategory;
  /** Set for a preset the user saved: it has a menu. */
  saved?: SavedPreset;
}

type Filter = 'all' | PresetCategory;
const FILTERS: readonly Filter[] = ['all', ...PRESET_CATEGORIES];

const NAME_MAX = 40;
const STATUS_MS = 6000;
const CARD_SELECTOR = 'button[data-preset-card]';


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

type Direction = 'left' | 'right' | 'up' | 'down';

const ARROWS: Record<string, Direction | undefined> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/**
 * The card to move to from `from` when an arrow key is pressed: the nearest one whose
 * centre lies in that direction, counting distance across the direction more heavily.
 */
function nextCard(from: HTMLElement, cards: readonly HTMLElement[], direction: Direction): HTMLElement | undefined {
  const origin = from.getBoundingClientRect();
  const ox = origin.left + origin.width / 2;
  const oy = origin.top + origin.height / 2;
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'right' || direction === 'down' ? 1 : -1;
  let best: HTMLElement | undefined;
  let bestScore = Infinity;
  for (const card of cards) {
    if (card === from) continue;
    const rect = card.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - ox;
    const dy = rect.top + rect.height / 2 - oy;
    const along = (horizontal ? dx : dy) * sign;
    // Cards in the same row or column are never "ahead" by less than a few pixels.
    if (along < 4) continue;
    const across = Math.abs(horizontal ? dy : dx);
    const score = along + across * 3;
    if (score < bestScore) {
      bestScore = score;
      best = card;
    }
  }
  return best;
}

/**
 * The current preset as a selector card in the panel; it opens a dropdown with every
 * preset in categories, and the actions to save, import, rename, export and delete.
 */
export function PresetPicker({ history }: Props) {
  const { t, i18n } = useTranslation();
  const { scene, edit } = history;
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [library, setLibrary] = useState<Library>({ presets: [], unreadable: [] });
  // The ids in the first list loaded in this editor session; a preset that is not one is new.
  const [initialIds, setInitialIds] = useState<ReadonlySet<string>>();
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
  const content = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  // The form a menu item opened, read when that menu closes (a closure would be stale).
  const modeRef = useRef<Mode>(undefined);
  const previousMode = useRef<Mode>(undefined);
  const seeAllRequested = useRef(false);
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
    setInitialIds((known) => known ?? new Set(result.data.presets.map((preset) => preset.id)));
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

  const openMode = (next: Mode) => {
    modeRef.current = next;
    setMode(next);
    setName(next.kind === 'rename' ? next.preset.name : '');
  };
  const closeMode = () => {
    modeRef.current = undefined;
    setMode(undefined);
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!mode || busy) return;
    if (mode.kind === 'delete') {
      const done = await run(() => deleteUserPreset(mode.preset.id));
      if (done !== undefined) closeMode();
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
    if (saved) closeMode();
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

  const language = i18n.language;
  const entries = useMemo<Entry[]>(() => {
    const builtIn: Entry[] = [...builtinPresets, ...devPresets].map((preset) => ({
      id: preset.id,
      name: presetName(preset, language),
      background: preset.background,
      category: presetCategory(preset.background, false),
    }));
    const images: Entry[] = imagePresets().map((preset) => ({
      id: preset.id,
      name: t(`editor.background.images.${preset.nameKey}`),
      background: preset.background,
      category: presetCategory(preset.background, false),
    }));
    const own: Entry[] = library.presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      background: preset.background,
      category: presetCategory(preset.background, true),
      saved: preset,
    }));
    return [...builtIn, ...images, ...own];
    // `t` changes with the language, which is what the names depend on.
  }, [devPresets, language, library.presets, t]);

  const current = entries.find((entry) => sameBackground(scene.background, entry.background));

  const captionOf = (background: BackgroundSpec) =>
    isAiPreset(background)
      ? t('editor.presets.caption.ai')
      : t(`editor.background.kind.${backgroundKind(background)}`);

  const pick = (entry: Entry) => {
    setOpen(false);
    if (current?.id === entry.id) return;
    void apply(entry.background);
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setFilter('all');
    else closeMode();
  };

  const cards = () => [...(content.current?.querySelectorAll<HTMLElement>(CARD_SELECTOR) ?? [])];

  const focusInitial = () => {
    const all = cards();
    const target = all.find((card) => card.getAttribute('aria-current') === 'true') ?? all[0];
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const focusForm = () => {
    const form = formRef.current;
    form?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus({ preventScroll: true });
    form?.scrollIntoView({ block: 'nearest' });
  };

  // Focus follows the form: into it when it opens, and back to a card when it closes, since
  // the focused element is gone with it.
  useEffect(() => {
    const before = previousMode.current;
    previousMode.current = mode;
    if (mode) {
      const frame = requestAnimationFrame(focusForm);
      return () => { cancelAnimationFrame(frame); };
    }
    if (before && open) {
      const own =
        before.kind === 'rename'
          ? content.current?.querySelector<HTMLElement>(`[data-testid="preset-${CSS.escape(before.preset.id)}"]`)
          : null;
      if (own) own.focus();
      else focusInitial();
    }
    // Only a change of the form moves focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // "See all" replaces the view and its button, so the first card of the new grid takes focus.
  useEffect(() => {
    if (!seeAllRequested.current) return;
    seeAllRequested.current = false;
    const first = cards()[0];
    first?.focus({ preventScroll: true });
    first?.scrollIntoView({ block: 'nearest' });
  }, [filter]);

  const onKeyDown = (event: KeyboardEvent) => {
    // The editor's window-level shortcuts (tools, Delete, Escape) must not act on the canvas
    // while the picker has the keys; Ctrl and Meta chords such as undo still pass.
    if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
    const direction = ARROWS[event.key];
    const target = event.target;
    if (!direction || !(target instanceof HTMLElement) || !target.matches(CARD_SELECTOR)) return;
    const next = nextCard(target, cards(), direction);
    event.preventDefault();
    if (!next) return;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const cardOf = (entry: Entry) => {
    const isNew = entry.saved !== undefined && initialIds !== undefined && !initialIds.has(entry.id);
    const ai = isAiPreset(entry.background);
    let label = entry.name;
    if (isNew) label = t('editor.presets.newName', { name: label });
    if (ai) label = t('editor.presets.aiName', { name: label });
    const badges = [ai ? t('editor.presets.aiBadge') : undefined, isNew ? t('editor.presets.newBadge') : undefined].filter(
      (badge): badge is string => badge !== undefined,
    );
    const saved = entry.saved;
    return (
      <PickerCard
        key={entry.id}
        title={entry.name}
        caption={captionOf(entry.background)}
        badges={badges}
        selected={sameBackground(scene.background, entry.background)}
        aria-label={label}
        data-preset-card=""
        data-testid={`preset-${entry.id}`}
        onClick={() => { pick(entry); }}
        overlay={
          saved && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  className="absolute right-[22px] bottom-[22px] size-7 rounded-full bg-card/90 opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100 data-[state=open]:opacity-100"
                  aria-label={t('editor.presets.more', { name: saved.name })}
                >
                  <MoreIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                // Focus goes to the form a menu item opens, not back to this button.
                onCloseAutoFocus={(event) => {
                  if (modeRef.current) {
                    event.preventDefault();
                    focusForm();
                  }
                }}
                onEscapeKeyDown={(event) => { event.stopPropagation(); }}
              >
                <DropdownMenuItem onSelect={() => { openMode({ kind: 'rename', preset: saved }); }}>
                  {t('editor.presets.rename')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { void exportFile(saved); }}>
                  {t('editor.presets.export')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => { openMode({ kind: 'delete', preset: saved }); }}
                >
                  {t('editor.presets.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      >
        <PresetThumb background={entry.background} />
      </PickerCard>
    );
  };

  const mineActions = (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-7"
        ref={saveButton}
        aria-label={t('editor.presets.saveCurrent')}
        title={t('editor.presets.saveCurrent')}
        disabled={busy}
        onClick={() => { openMode({ kind: 'save' }); }}
      >
        <AddIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-7"
        aria-label={t('editor.presets.import')}
        title={t('editor.presets.import')}
        disabled={busy}
        onClick={() => { fileInput.current?.click(); }}
      >
        <UploadIcon />
      </Button>
    </>
  );

  const section = (category: PresetCategory, all: boolean) => {
    const list = entries.filter((entry) => entry.category === category);
    const unreadable = category === 'mine' ? library.unreadable : [];
    const alwaysShown = category === 'ai' || category === 'mine';
    if (all && !alwaysShown && list.length === 0) return null;
    const empty = list.length === 0 && unreadable.length === 0;
    return (
      <PickerSection
        key={category}
        title={t(`editor.presets.section.${category}`)}
        actions={category === 'mine' ? mineActions : undefined}
        onSeeAll={all && list.length > 0 ? () => {
              seeAllRequested.current = true;
              setFilter(category);
            } : undefined}
        seeAllLabel={t('editor.presets.seeAll')}
      >
        {empty && <p className="text-caption px-4">{t(`editor.presets.empty.${category}`)}</p>}
        {list.length > 0 && (all ? <PickerRow>{list.map(cardOf)}</PickerRow> : <PickerGrid>{list.map(cardOf)}</PickerGrid>)}
        {unreadable.length > 0 && (
          <div className="flex flex-col gap-1 px-4">
            {unreadable.map((entry) => (
              <div key={entry.id} className="text-caption flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{t('editor.presets.unreadable', { name: entry.name })}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void run(() => deleteUserPreset(entry.id)).then(() => {
                      // The row goes away with its button, so focus moves to one that stays.
                      requestAnimationFrame(() => { saveButton.current?.focus(); });
                    });
                  }}
                >
                  {t('editor.presets.delete')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </PickerSection>
    );
  };

  const notices = (
    <>
      {error && <ErrorNotice error={error} onDismiss={() => { setError(undefined); }} />}
      {status && <p className="text-caption">{status}</p>}
    </>
  );

  const currentName = current?.name ?? t('editor.presets.currentName');
  const hasNotice = error !== undefined || status !== undefined;

  return (
    <div className="flex flex-col gap-2.5">
        <Popover open={open} onOpenChange={onOpenChange}>
          <PopoverTrigger asChild>
            <SelectorCard
              title={currentName}
              caption={captionOf(scene.background)}
              aria-label={t('editor.panel.presetOpen', { name: currentName })}
              thumbnail={current ? <PresetThumb background={current.background} /> : <span className="size-full bg-secondary" />}
              data-testid="preset-picker"
              data-current-preset={current?.id ?? ''}
            />
          </PopoverTrigger>
          <PickerContent
            ref={content}
            aria-label={t('editor.presets.picker')}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              focusInitial();
            }}
            // Escape closes an open form first, and the picker only the next time.
            onEscapeKeyDown={(event) => {
              // Stopped here, in Radix's capture-phase listener, so it never reaches the window's.
              event.stopPropagation();
              if (mode) {
                event.preventDefault();
                closeMode();
              }
            }}
            onKeyDown={onKeyDown}
            header={
              <PickerPills
                aria-label={t('editor.presets.picker')}
                value={filter}
                onValueChange={(next) => { setFilter(next as Filter); }}
              >
                {FILTERS.map((value) => (
                  <PickerPill key={value} value={value}>
                    {t(`editor.presets.filter.${value}`)}
                  </PickerPill>
                ))}
              </PickerPills>
            }
          >
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
            {hasNotice && <div className="flex flex-col gap-2 px-4">{notices}</div>}
            {mode && (
              <form ref={formRef} className="flex flex-col gap-2 px-4" onSubmit={(event) => { void submit(event); }}>
                {mode.kind === 'delete' ? (
                  <p className="text-control-sm">{t('editor.presets.deleteConfirm', { name: mode.preset.name })}</p>
                ) : (
                  <Input
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
                  <Button type="button" variant="ghost" onClick={closeMode}>
                    {t('editor.presets.cancel')}
                  </Button>
                </div>
              </form>
            )}
            <div key={filter} className="flex animate-fade-in flex-col gap-5">
              {filter === 'all'
                ? PRESET_CATEGORIES.map((category) => section(category, true))
                : section(filter, false)}
            </div>
          </PickerContent>
        </Popover>
        {!open && hasNotice && notices}
    </div>
  );
}
