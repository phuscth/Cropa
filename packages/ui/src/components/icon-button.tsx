import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/utils.ts';

interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: ReactNode;
  /** The accessible name, also shown as a tooltip under the button on hover and keyboard focus. */
  label: string;
  /** Marks the view on screen. */
  active?: boolean;
}

/**
 * A 32px square with an 18px icon; its name shows only as a tooltip that fades
 * and slides in below it. The tooltip stays hidden while a menu the button
 * opens is open.
 */
function IconButton({ className, icon, label, active = false, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      data-slot="icon-button"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'press focus-ring group/icon-button relative flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-[18px]',
        active
          ? 'bg-selected text-foreground shadow-soft'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
        className,
      )}
      {...props}
    >
      {icon}
      {/* The button's aria-label already names it, so the tooltip is visual only. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-full left-1/2 z-50 mt-1.5 hidden -translate-x-1/2 animate-tooltip-in rounded-md bg-foreground px-2 py-1 text-tiny whitespace-nowrap text-background shadow-md group-hover/icon-button:block group-focus-visible/icon-button:block group-data-[state=open]/icon-button:invisible"
      >
        {label}
      </span>
    </button>
  );
}

export { IconButton };
