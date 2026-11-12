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
      className={cn('grid w-full grid-flow-col gap-1 rounded-md bg-secondary p-0.5', className)}
      {...props}
    />
  );
}

function SegmentedControlItem({ className, ...props }: ComponentProps<typeof ToggleGroup.Item>) {
  return (
    <ToggleGroup.Item
      data-slot="segmented-control-item"
      className={cn(
        'inline-flex h-7 min-w-0 items-center justify-center rounded-md px-2 text-sm whitespace-nowrap outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-selected data-[state=on]:text-selected-foreground',
        className,
      )}
      {...props}
    />
  );
}

export { SegmentedControl, SegmentedControlItem };
