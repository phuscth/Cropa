import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/utils.ts';

interface NavRailProps extends ComponentProps<'aside'> {
  /** An optional 32px mark above the items. */
  logo?: ReactNode;
  /** Items pinned to the bottom. */
  footer?: ReactNode;
}

/** A 96px side rail: items from the top, then a footer pinned to the bottom. */
function NavRail({ className, logo, footer, children, ...props }: NavRailProps) {
  return (
    <aside
      data-slot="nav-rail"
      className={cn('relative z-20 flex w-24 shrink-0 flex-col items-center bg-sidebar pt-2 pb-3', className)}
      {...props}
    >
      {logo ? <div className="mb-9 flex size-8 items-center justify-center">{logo}</div> : null}
      <nav className="flex flex-col items-center gap-1">{children}</nav>
      {footer ? <div className="mt-auto flex flex-col items-center gap-1">{footer}</div> : null}
    </aside>
  );
}

interface NavRailItemProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: ReactNode;
  /** The accessible name, also shown as a tooltip on hover and keyboard focus. */
  label: string;
  active?: boolean;
}

/** A 72x44px pill with a 20px icon; its name shows only as a tooltip. */
function NavRailItem({ className, icon, label, active = false, ...props }: NavRailItemProps) {
  return (
    <button
      type="button"
      data-slot="nav-rail-item"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex h-11 w-18 items-center justify-center rounded-full outline-none transition-[color,background-color,box-shadow] duration-150 ease-enter focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-5',
        active
          ? 'bg-selected text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        className,
      )}
      {...props}
    >
      {icon}
      {/* The button's aria-label already names it, so the tooltip is visual only. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-full z-50 ml-2 -translate-y-1/2 rounded-md bg-foreground px-2 py-1 text-xs font-medium whitespace-nowrap text-background opacity-0 shadow-md transition-opacity duration-150 ease-enter group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {label}
      </span>
    </button>
  );
}

export { NavRail, NavRailItem };
