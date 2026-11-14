import { ToggleGroup } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/utils.ts';

type OptionListProps = Omit<
  ComponentProps<typeof ToggleGroup.Root>,
  'type' | 'value' | 'defaultValue' | 'onValueChange' | 'orientation'
> & {
  /** The selected item, or `undefined` when none matches. */
  value: string | undefined;
  onValueChange: (value: string) => void;
};

/**
 * A vertical list of choices, one selected at a time; clicking the selected item keeps
 * it selected. Each item shows a label and an optional detail on its right.
 */
function OptionList({ className, value, onValueChange, ...props }: OptionListProps) {
  return (
    <ToggleGroup.Root
      data-slot="option-list"
      type="single"
      orientation="vertical"
      value={value ?? ''}
      onValueChange={(next) => {
        if (next !== '') onValueChange(next);
      }}
      className={cn('flex flex-col gap-0.5 rounded-[12px] bg-secondary p-[3px]', className)}
      {...props}
    />
  );
}

type OptionListItemProps = Omit<ComponentProps<typeof ToggleGroup.Item>, 'children'> & {
  label: ReactNode;
  detail?: ReactNode;
};

function OptionListItem({ className, label, detail, ...props }: OptionListItemProps) {
  return (
    <ToggleGroup.Item
      data-slot="option-list-item"
      className={cn(
        'focus-ring flex h-8 items-center justify-between rounded-[9px] px-3 text-control whitespace-nowrap text-muted-foreground transition-colors duration-150 ease-enter hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-soft dark:data-[state=on]:bg-foreground/15',
        className,
      )}
      {...props}
    >
      <span>{label}</span>
      {detail !== undefined && <span className="text-caption tabular-nums">{detail}</span>}
    </ToggleGroup.Item>
  );
}

export { OptionList, OptionListItem };
