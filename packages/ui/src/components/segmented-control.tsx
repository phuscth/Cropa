import { ToggleGroup } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/utils.ts';

type SegmentedControlProps = Omit<
  ComponentProps<typeof ToggleGroup.Root>,
  'type' | 'value' | 'defaultValue' | 'onValueChange'
> & {
  /** The selected item, or `undefined` when none matches. */
  value: string | undefined;
  onValueChange: (value: string) => void;
};

/** One item is selected at a time; clicking the selected item keeps it selected. */
function SegmentedControl({ className, value, onValueChange, ...props }: SegmentedControlProps) {
  return (
    <ToggleGroup.Root
      data-slot="segmented-control"
      type="single"
      value={value ?? ''}
      onValueChange={(next) => {
        if (next !== '') onValueChange(next);
      }}
      className={cn('grid w-full grid-flow-col gap-1 rounded-full bg-secondary p-1', className)}
      {...props}
    />
  );
}

function SegmentedControlItem({ className, ...props }: ComponentProps<typeof ToggleGroup.Item>) {
  return (
    <ToggleGroup.Item
      data-slot="segmented-control-item"
      className={cn(
        'inline-flex h-8 min-w-0 items-center justify-center rounded-full px-3 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-[color,background-color,box-shadow] duration-150 ease-enter hover:text-foreground focus-visible:ring-4 focus-visible:ring-primary/16 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-xs',
        className,
      )}
      {...props}
    />
  );
}

export { SegmentedControl, SegmentedControlItem };
