import type { ReactNode } from 'react';

import { cn } from '../lib/utils.ts';

interface ButtonTooltip {
  /** What the tooltip says. */
  label: string;
  /** The keys of the button's shortcut, one per keycap after the label, such as `['Ctrl', 'Z']`. */
  keys?: readonly string[];
  /** Below the button (default), or above it for a button near the bottom of its area. */
  side?: 'top' | 'bottom';
  /** The edge of the button the tooltip lines up with; a button at the edge of a clipped area uses `start` or `end`. */
  align?: 'start' | 'center' | 'end';
}

const SIDE = {
  // `--tooltip-from` turns the slide of `tooltip-in` so the tooltip always comes out of its button.
  top: 'bottom-full mb-1.5 [--tooltip-from:1]',
  bottom: 'top-full mt-1.5',
} as const;

const ALIGN = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0',
} as const;

/**
 * Wraps a button so its tooltip shows on hover and keyboard focus, fading and
 * sliding in. Hover is caught by the wrapper, so a disabled button (which takes
 * no pointer events) still shows it. It stays hidden while a menu or popover
 * the button opens is open (`data-state=open`). Visual only: the button names
 * itself with its `aria-label`, so the tooltip does not repeat it to screen readers.
 */
function WithTooltip({ tooltip, children }: { tooltip: ButtonTooltip; children: ReactNode }) {
  const { label, keys = [], side = 'bottom', align = 'center' } = tooltip;
  return (
    <span data-slot="tooltip-anchor" className="group/tooltip relative inline-flex shrink-0">
      {children}
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute z-50 hidden animate-tooltip-in items-center rounded-md bg-foreground px-2 py-1 text-tiny whitespace-nowrap text-background shadow-md group-hover/tooltip:flex group-has-[:focus-visible]/tooltip:flex group-has-[[data-state=open]]/tooltip:invisible',
          SIDE[side],
          ALIGN[align],
        )}
      >
        {label}
        {keys.length > 0 && (
          <span className="ml-1.5 flex gap-1">
            {keys.map((key) => (
              // Keycaps in the page colour on the inverted tooltip, so they read in both themes.
              <kbd
                key={key}
                className="flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-background/70 px-1 font-sans text-[11px] leading-none font-semibold text-foreground"
              >
                {key}
              </kbd>
            ))}
          </span>
        )}
      </span>
    </span>
  );
}

export { WithTooltip, type ButtonTooltip };
