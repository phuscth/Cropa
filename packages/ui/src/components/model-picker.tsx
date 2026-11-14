import { Popover as PopoverPrimitive } from 'radix-ui';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { CheckIcon, ChevronDownIcon, SearchIcon, StarFilledIcon, StarIcon } from '../icons.tsx';
import { filterModels, nextActive } from '../lib/model-picker.ts';
import type { ModelFilter } from '../lib/model-picker.ts';
import { cn } from '../lib/utils.ts';

interface ModelPickerProvider {
  id: string;
  label: string;
  logo: ReactNode;
  /** Shown instead of the list when the provider can't be used. */
  unavailable?: ReactNode;
}

interface ModelPickerModel {
  provider: string;
  id: string;
  name: string;
  isNew?: boolean;
  favorite: boolean;
  /** False hides the star, for an entry that cannot be kept as a favorite. Default true. */
  favoritable?: boolean;
}

interface ModelPickerProps {
  providers: ModelPickerProvider[];
  /** Every provider's models, in display order. */
  models: ModelPickerModel[];
  /** The selected entry. */
  value: { provider: string; id: string } | null;
  /** Picking an entry also closes the popover. */
  onChange: (provider: string, id: string) => void;
  onToggleFavorite: (provider: string, id: string, favorite: boolean) => void;
  /** The short model name shown on the trigger. */
  triggerLabel: string;
  triggerLogo: ReactNode;
  disabled?: boolean;
  /** A muted line above the list, for example that the model list could not be read. */
  notice?: ReactNode;
  labels: {
    trigger: string;
    search: string;
    favorites: string;
    addFavorite: (name: string) => string;
    removeFavorite: (name: string) => string;
    newBadge: string;
    noFavorites: string;
    noMatch: (query: string) => string;
  };
}

const railButton =
  'focus-ring flex shrink-0 items-center justify-center rounded-md transition-colors duration-150 ease-enter hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground text-muted-foreground';

const keyOf = (provider: string, id: string) => `${provider}\u0000${id}`;

/**
 * A model chooser for the chat composer: a rail that filters by favorites or provider, a
 * search box and a list of models with a star on each. Controlled and display-only.
 */
function ModelPicker({
  providers,
  models,
  value,
  onChange,
  onToggleFavorite,
  triggerLabel,
  triggerLogo,
  disabled,
  notice,
  labels,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<ModelFilter>(value?.provider ?? providers[0]?.id ?? 'favorites');
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const optionId = (key: string) => `${listboxId}-${key.replace(/\W/g, '_')}`;

  const visible = useMemo(() => filterModels(models, filter, query), [models, filter, query]);
  const selectedKey = value ? keyOf(value.provider, value.id) : null;
  const active = visible.find((m) => keyOf(m.provider, m.id) === activeKey) ?? visible[0];
  const activeEntryKey = active ? keyOf(active.provider, active.id) : null;
  const providerById = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);
  const filteredProvider = filter === 'favorites' ? undefined : providerById.get(filter);

  useEffect(() => {
    if (!open || activeEntryKey === null) return;
    listRef.current?.querySelector(`[id="${optionId(activeEntryKey)}"]`)?.scrollIntoView({ block: 'nearest' });
    // optionId only depends on listboxId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeEntryKey]);

  function handleOpenChange(next: boolean) {
    if (next) {
      const startFilter = value?.provider ?? providers[0]?.id ?? 'favorites';
      setFilter(startFilter);
      setQuery('');
      setActiveKey(selectedKey);
    }
    setOpen(next);
  }

  function pick(provider: string, id: string) {
    onChange(provider, id);
    setOpen(false);
  }

  function selectFilter(next: ModelFilter) {
    setFilter(next);
    setActiveKey(null);
    inputRef.current?.focus();
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const { key } = event;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault();
      const current = visible.findIndex((m) => keyOf(m.provider, m.id) === activeEntryKey);
      const next = visible[nextActive(current, visible.length, key)];
      if (next) setActiveKey(keyOf(next.provider, next.id));
    } else if (key === 'Enter') {
      event.preventDefault();
      if (active) pick(active.provider, active.id);
    }
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          data-slot="model-picker-trigger"
          disabled={disabled}
          aria-label={labels.trigger}
          className="focus-ring group flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-foreground transition-colors duration-150 ease-enter hover:bg-secondary disabled:pointer-events-none disabled:opacity-50"
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-[16px]">{triggerLogo}</span>
          <span className="max-w-[140px] truncate">{triggerLabel}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 transition-transform duration-150 ease-enter group-data-[state=open]:rotate-180" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-slot="model-picker"
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={6}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          className="z-50 flex h-[328px] max-h-(--radix-popover-content-available-height) w-[368px] max-w-[calc(100vw-12px)] origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-lg border border-foreground/10 bg-popover text-popover-foreground outline-none data-[state=closed]:animate-model-picker-out data-[state=open]:animate-model-picker-in"
        >
          <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-foreground/10 bg-muted/30 p-1.5">
            <button
              type="button"
              aria-label={labels.favorites}
              aria-pressed={filter === 'favorites'}
              onClick={() => { selectFilter('favorites'); }}
              className={cn(railButton, 'size-7')}
            >
              <StarIcon className="size-4" />
            </button>
            <div role="separator" className="my-0.5 h-px w-5 bg-foreground/10" />
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                aria-label={provider.label}
                aria-pressed={filter === provider.id}
                onClick={() => { selectFilter(provider.id); }}
                className={cn(railButton, 'size-8 text-[16px]')}
              >
                {provider.logo}
              </button>
            ))}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-[41px] shrink-0 items-center gap-2 border-b border-foreground/10 px-3">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded
                aria-controls={listboxId}
                aria-activedescendant={activeEntryKey ? optionId(activeEntryKey) : undefined}
                aria-autocomplete="list"
                aria-label={labels.search}
                value={query}
                placeholder={labels.search}
                onChange={(event) => { setQuery(event.target.value); }}
                onKeyDown={onSearchKeyDown}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            {notice !== undefined && notice !== null && (
              <div className="shrink-0 px-3 pt-2 text-[12px] leading-snug text-muted-foreground">{notice}</div>
            )}
            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label={filter === 'favorites' ? labels.favorites : filteredProvider?.label}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2"
            >
              {filteredProvider?.unavailable ? (
                <div className="flex flex-1 items-center justify-center p-2 text-center text-[13px] text-muted-foreground">
                  {filteredProvider.unavailable}
                </div>
              ) : visible.length === 0 ? (
                <p className="flex flex-1 items-center justify-center p-2 text-center text-[13px] text-muted-foreground">
                  {query.trim() !== ''
                    ? labels.noMatch(query.trim())
                    : filter === 'favorites'
                      ? labels.noFavorites
                      : null}
                </p>
              ) : (
                visible.map((model) => {
                  const key = keyOf(model.provider, model.id);
                  const provider = providerById.get(model.provider);
                  const selected = key === selectedKey;
                  return (
                    <div
                      key={key}
                      id={optionId(key)}
                      role="option"
                      aria-selected={selected}
                      onClick={() => { pick(model.provider, model.id); }}
                      onMouseMove={() => { if (activeKey !== key) setActiveKey(key); }}
                      className={cn(
                        'flex h-[52px] shrink-0 cursor-default items-center gap-3 rounded-md px-2.5 py-2 transition-colors duration-150 ease-enter',
                        (selected || key === activeEntryKey) && 'bg-accent',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[14px] font-normal">{model.name}</span>
                          {model.isNew && (
                            <span className="shrink-0 rounded border border-foreground/10 bg-muted px-1 py-0.5 text-[9px] leading-none font-semibold text-muted-foreground uppercase">
                              {labels.newBadge}
                            </span>
                          )}
                        </div>
                        {provider && (
                          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] leading-none text-muted-foreground">
                            <span className="flex size-[11px] shrink-0 items-center justify-center text-[11px]">
                              {provider.logo}
                            </span>
                            <span className="truncate">{provider.label}</span>
                          </div>
                        )}
                      </div>
                      {selected && <CheckIcon className="size-4 shrink-0" aria-hidden />}
                      {model.favoritable !== false && (
                      <button
                        type="button"
                        aria-label={model.favorite ? labels.removeFavorite(model.name) : labels.addFavorite(model.name)}
                        aria-pressed={model.favorite}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleFavorite(model.provider, model.id, !model.favorite);
                        }}
                        className={cn(
                          'focus-ring flex h-7 w-[27px] shrink-0 items-center justify-center rounded-sm transition-colors duration-150 ease-enter',
                          model.favorite ? 'text-[#FFB700]' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {model.favorite ? <StarFilledIcon className="size-4" /> : <StarIcon className="size-4" />}
                      </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export { ModelPicker };
export type { ModelPickerModel, ModelPickerProps, ModelPickerProvider };
