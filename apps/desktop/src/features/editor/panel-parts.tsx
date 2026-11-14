import { Input, SliderField } from '@cropa/ui';
import { useState, type CSSProperties } from 'react';

import type { FrameStyle, ShadowLevel } from './scene-edits.ts';

interface SliderRowProps {
  label: string;
  value: string;
  current: number;
  range: readonly [number, number];
  onPreview: (value: number) => void;
  onCommit: () => void;
}

/** A slider over a scene value: it previews while dragging and commits one undo step on release. */
export function SliderRow({ label, value, current, range, onPreview, onCommit }: SliderRowProps) {
  return (
    <SliderField
      label={label}
      valueText={value}
      min={Math.min(range[0], current)}
      max={Math.max(range[1], current)}
      step={1}
      value={[current]}
      onValueChange={([next]) => {
        if (next !== undefined) onPreview(next);
      }}
      // Radix commits a keyboard change before it reports the value, so wait for the
      // preview to be dispatched; otherwise the drag would stay open.
      onValueCommit={() => { queueMicrotask(onCommit); }}
    />
  );
}

/** The shadow each level casts in its tile, drawn in CSS: an illustration, not the renderer. */
const SHADOW_SWATCH: Record<ShadowLevel, CSSProperties['boxShadow']> = {
  none: 'none',
  soft: '0 2px 5px rgb(0 0 0 / 0.2)',
  medium: '0 4px 10px rgb(0 0 0 / 0.32)',
  strong: '0 6px 14px rgb(0 0 0 / 0.5)',
};

/** A white card peeking from the bottom-right of the tile, casting the level's shadow. */
export function ShadowThumb({ level }: { level: ShadowLevel }) {
  return (
    <span
      aria-hidden="true"
      className="absolute top-[30%] left-[30%] size-full rounded-[7px] bg-white"
      style={{ boxShadow: SHADOW_SWATCH[level] }}
    />
  );
}

/** The soft two-colour ground every style tile is drawn on. */
const STYLE_GROUND = 'linear-gradient(135deg, #5b7cfa 0%, #4fc3e8 100%)';

/**
 * A style tile's drawing in CSS: a screen corner peeking from the bottom-right,
 * dressed as the style dresses the screenshot. An illustration, not the renderer:
 * at tile size the real frame widths are under a pixel.
 */
export function StyleThumb({ style }: { style: FrameStyle }) {
  // The band around the screen: its fill, padding and corner.
  const band: Record<FrameStyle, string> = {
    none: '',
    glassLight: 'bg-white/45 p-[4px] rounded-tl-[10px]',
    glassDark: 'bg-black/35 p-[4px] rounded-tl-[10px]',
    inset: 'bg-white/90 p-[5px] rounded-tl-[10px]',
    outline: 'rounded-tl-[7px] shadow-[0_0_0_1px_rgba(255,255,255,0.7)]',
    border: 'bg-white p-[3px] rounded-tl-[10px]',
  };
  const screen = style === 'inset' ? 'bg-[#c9cad6]' : 'bg-[#f6f6f8]';
  return (
    <span
      aria-hidden="true"
      className="absolute inset-0 overflow-hidden"
      style={{ background: STYLE_GROUND }}
    >
      <span className={`absolute top-[32%] left-[28%] size-full ${band[style]}`}>
        <span className={`block size-full rounded-tl-[6px] ${screen}`} />
      </span>
    </span>
  );
}

/** A rectangle outline in the given ratio, at most 28px on its long side. */
export function RatioThumb({ ratio }: { ratio: readonly [number, number] }) {
  const scale = 28 / Math.max(ratio[0], ratio[1]);
  return (
    <span
      aria-hidden="true"
      className="rounded-[3px] border-2 border-foreground/60"
      style={{ width: ratio[0] * scale, height: ratio[1] * scale }}
    />
  );
}

/** Auto adapts to the image, so its outline is dashed. */
export function AutoThumb() {
  return (
    <span
      aria-hidden="true"
      className="h-5 w-7 rounded-[3px] border-2 border-dashed border-foreground/60"
    />
  );
}

/** Custom is an outline with a plus. */
export function CustomThumb() {
  return (
    <span
      aria-hidden="true"
      className="relative flex h-5 w-7 items-center justify-center rounded-[3px] border-2 border-foreground/60"
    >
      <svg viewBox="0 0 8 8" className="size-2" fill="currentColor">
        <path d="M3.25 0h1.5v3.25H8v1.5H4.75V8h-1.5V4.75H0v-1.5h3.25z" />
      </svg>
    </span>
  );
}

/** A positive number field for one side of a custom aspect ratio; an invalid entry reverts. */
export function RatioField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(String(value));
  }
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() !== '' && parsed >= 0.01 && parsed <= 100) onCommit(parsed);
    // An accepted value comes back through `value`; a rejected one is dropped.
    setDraft(String(value));
  };
  return (
    <Input
      type="number"
      min={0.01}
      max={100}
      step="any"
      aria-label={label}
      value={draft}
      onChange={(event) => { setDraft(event.target.value); }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
}
