import { useEffect, useRef, useState } from 'react';

import { cn } from '../lib/utils.ts';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/;

/** Lower-case `#rrggbb[aa]` from `#rgb`, `#rrggbb` or `#rrggbbaa`, or null. */
function normalizeHex(input: string): string | null {
  const text = input.trim().toLowerCase();
  const prefixed = text.startsWith('#') ? text : `#${text}`;
  if (!HEX.test(prefixed)) return null;
  if (prefixed.length === 4) {
    const [, r = '', g = '', b = ''] = prefixed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return prefixed;
}

interface ColorInputProps {
  /** `#rrggbb` or `#rrggbbaa`. */
  value: string;
  /** Fires continuously while the picker is dragged. */
  onValueChange?: (hex: string) => void;
  /** Fires once when the picker closes or a typed value is accepted. */
  onValueCommit?: (hex: string) => void;
  disabled?: boolean;
  /** Names for the two parts; the caller translates them. */
  swatchLabel: string;
  textLabel: string;
  className?: string;
}

/** A colour swatch that opens the native picker, and a hex field. */
function ColorInput({
  value,
  onValueChange,
  onValueCommit,
  disabled,
  swatchLabel,
  textLabel,
  className,
}: ColorInputProps) {
  const [draft, setDraft] = useState(value);
  // A new value from outside replaces what was typed.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const pickerRef = useRef<HTMLInputElement>(null);
  const alpha = value.length === 9 ? value.slice(7) : '';
  // Latest props for the native listener, which is attached once.
  const latest = useRef({ alpha, onValueCommit });
  useEffect(() => {
    latest.current = { alpha, onValueCommit };
  });

  // React's onChange is the native `input` event; the picker's `change` event
  // (the picker closing) is the commit.
  useEffect(() => {
    const picker = pickerRef.current;
    if (!picker) return;
    const onChange = () => {
      latest.current.onValueCommit?.(picker.value + latest.current.alpha);
    };
    picker.addEventListener('change', onChange);
    return () => {
      picker.removeEventListener('change', onChange);
    };
  }, []);

  const commitDraft = () => {
    const hex = normalizeHex(draft);
    if (hex === null) {
      setDraft(value);
      return;
    }
    setDraft(hex);
    if (hex !== value) onValueCommit?.(hex);
  };

  return (
    <div data-slot="color-input" className={cn('flex items-center gap-2', className)}>
      <span
        className={cn(
          'checkerboard relative size-8 shrink-0 overflow-hidden rounded-md border shadow-xs focus-within:ring-[3px] focus-within:ring-ring/50',
          disabled && 'opacity-50',
        )}
      >
        <span className="absolute inset-0" style={{ backgroundColor: value }} />
        <input
          ref={pickerRef}
          type="color"
          value={value.slice(0, 7)}
          disabled={disabled}
          aria-label={swatchLabel}
          onChange={(event) => {
            onValueChange?.(event.target.value + alpha);
          }}
          className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
        />
      </span>
      <input
        type="text"
        value={draft}
        disabled={disabled}
        aria-label={textLabel}
        spellCheck={false}
        maxLength={9}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commitDraft();
        }}
        className="h-8 w-full min-w-0 rounded-md border bg-background px-3 py-1 font-mono text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
      />
    </div>
  );
}

export { ColorInput };
