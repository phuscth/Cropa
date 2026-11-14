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
      className={cn('grid grid-cols-3 gap-x-1 gap-y-2.5', className)}
      {...props}
    />
  );
}

type TileProps = Omit<ComponentProps<typeof ToggleGroup.Item>, 'children' | 'title'> & {
  /** The name under the thumbnail; truncated with an ellipsis, so it is also the tooltip and the accessible name. */
  label: string;
  /** The thumbnail's content. */
  children: ReactNode;
  /** Sizing of the thumbnail, for example `h-12` (the default) or `aspect-square`. */
  thumbClassName?: string;
  /** Positioned over the tile, for example a menu button. */
  overlay?: ReactNode;
};

/**
 * A rounded thumbnail on a soft surface with its name under it. The selected
 * tile grows a 2px ring in the text colour with a 2px gap; hover lifts the
 * tile 1px and press scales it to .97.
 */
function Tile({ className, label, children, thumbClassName, overlay, ...props }: TileProps) {
  return (
    <div data-slot="tile" className="group relative min-w-0 p-0.5">
      <ToggleGroup.Item
        aria-label={label}
        title={label}
        className={cn(
          'group/tile focus-ring flex w-full min-w-0 flex-col gap-1.5 rounded-[11px] transition-[transform,scale] duration-150 ease-enter active:scale-[var(--press-scale,0.97)]',
          className,
        )}
        {...props}
      >
        <span
          className={cn(
            'relative flex h-12 items-center justify-center overflow-hidden rounded-[11px] bg-secondary outline-[1.5px] outline-offset-0 outline-transparent transition-[outline-color,outline-offset,box-shadow,transform,translate] duration-200 ease-enter group-hover/tile:-translate-y-px group-hover/tile:shadow-soft-hover group-data-[state=on]/tile:outline-foreground/45 group-data-[state=on]/tile:outline-offset-2 group-disabled/tile:opacity-50',
            thumbClassName,
          )}
        >
          {children}
        </span>
        <span className="text-caption block w-full truncate text-center group-hover/tile:text-foreground group-data-[state=on]/tile:text-foreground">
          {label}
        </span>
      </ToggleGroup.Item>
      {overlay}
    </div>
  );
}

export { Tile, TileGroup };
