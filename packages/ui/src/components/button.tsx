import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/utils.ts';
import { WithTooltip, type ButtonTooltip } from './tooltip.tsx';

const buttonVariants = cva(
  "press focus-ring inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-control disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/85',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-transparent hover:bg-accent',
        secondary: 'rounded-[11px] bg-secondary text-secondary-foreground hover:bg-secondary/70 dark:hover:bg-foreground/10',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 gap-1.5 px-3 text-control-sm',
        lg: 'h-11 px-6',
        icon: "size-9 [&_svg:not([class*='size-'])]:size-5",
        'icon-sm': 'size-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** A tooltip for an icon-only button, in place of a native `title`. */
    tooltip?: ButtonTooltip;
  };

function Button({ className, variant, size, asChild = false, tooltip, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  // The tooltip is hidden from screen readers, so what it adds to the name is described here instead.
  const description =
    tooltip && tooltip.label !== props['aria-label'] ? tooltip.label : undefined;
  const keyShortcuts = tooltip?.keys
    ?.map((key) => (key === 'Ctrl' ? 'Control' : key))
    .join('+');
  const button = (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      aria-description={description}
      aria-keyshortcuts={keyShortcuts}
      {...props}
    />
  );
  return tooltip ? <WithTooltip tooltip={tooltip}>{button}</WithTooltip> : button;
}

export { Button, buttonVariants };
