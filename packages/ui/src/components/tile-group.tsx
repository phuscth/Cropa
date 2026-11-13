import { ToggleGroup } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/utils.ts';

type TileGroupProps = Omit<
  ComponentProps<typeof ToggleGroup.Root>,
  'type' | 'value' | 'defaultValue' | 'onValueChange'
> & {
  /** The selected tile, or `undefined` when none matches. */
  value: string | undefined;
  onValueChange: (value: string) => void;
};

/**
 * A grid of tiles, one selected at a time. Give it an `aria-label`; arrow keys
 * move between tiles. Clicking the selected tile keeps it selected.
 */
function TileGroup({ className, value, onValueChange, ...props }: TileGroupProps) {
  return (
    <ToggleGroup.Root
      data-slot="tile-group"
      type="single"
      value={value ?? ''}
      onValueChange={(next) => {
        if (next !== '') onValueChange(next);
      }}
      className={cn('grid grid-cols-3 gap-x-2 gap-y-3', className)}
      {...props}
    />
  );
}

type TileProps = Omit<ComponentProps<typeof ToggleGroup.Item>, 'children' | 'title'> & {
  /** The name under the thumbnail; truncated with an ellipsis, so it is also the tooltip and the accessible name. */
  label: string;
  /** The thumbnail's content. */
  children: ReactNode;
  /** Sizing of the thumbnail, for example `aspect-square` (the default) or `h-12`. */
  thumbClassName?: string;
  /** Positioned over the tile, for example a menu button. */
  overlay?: ReactNode;
};

/** A rounded thumbnail on a soft surface with its name under it; a ring marks the selected one. */
function Tile({ className, label, children, thumbClassName, overlay, ...props }: TileProps) {
  return (
    <div data-slot="tile" className="group relative min-w-0">
      <ToggleGroup.Item
        aria-label={label}
        title={label}
        className={cn('group/tile flex w-full min-w-0 flex-col gap-1.5 rounded-xl outline-none', className)}
        {...props}
      >
        <span
          className={cn(
            'relative flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-secondary ring-offset-2 ring-offset-panel transition-[box-shadow] duration-150 ease-enter group-data-[state=on]/tile:ring-2 group-data-[state=on]/tile:ring-foreground group-focus-visible/tile:outline-2 group-focus-visible/tile:outline-offset-4 group-focus-visible/tile:outline-primary group-disabled/tile:opacity-50',
            thumbClassName,
          )}
        >
          {children}
        </span>
        <span className="block w-full truncate text-center text-xs text-muted-foreground group-hover/tile:text-foreground group-data-[state=on]/tile:text-foreground">
          {label}
        </span>
      </ToggleGroup.Item>
      {overlay}
    </div>
  );
}

export { Tile, TileGroup };
