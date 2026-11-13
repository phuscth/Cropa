import type { ComponentProps, ReactNode } from 'react';

import { cn } from '../lib/utils.ts';

interface NavRailProps extends ComponentProps<'aside'> {
  /** The mark at the top. */
  logo?: ReactNode;
  /** Items pinned to the bottom. */
  footer?: ReactNode;
}

/** A 96px side rail: logo, then items, then a footer pinned to the bottom. */
function NavRail({ className, logo, footer, children, ...props }: NavRailProps) {
  return (
    <aside
      data-slot="nav-rail"
      className={cn('flex w-24 shrink-0 flex-col items-center gap-1 bg-sidebar py-3', className)}
      {...props}
    >
      {logo ? <div className="mb-3 flex h-10 items-center justify-center">{logo}</div> : null}
      <nav className="flex flex-col items-center gap-1">{children}</nav>
      {footer ? <div className="mt-auto flex flex-col items-center gap-1">{footer}</div> : null}
    </aside>
  );
}

interface NavRailItemProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: ReactNode;
  /** Shown under the pill; also the accessible name and tooltip. */
  label: string;
  active?: boolean;
}

/** A 72x44px pill with a 20px icon and a short label under it. */
function NavRailItem({ className, icon, label, active = false, ...props }: NavRailItemProps) {
  return (
    <button
      type="button"
      data-slot="nav-rail-item"
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn('group flex w-20 flex-col items-center gap-1 outline-none', className)}
      {...props}
    >
      <span
        className={cn(
          'flex h-11 w-18 items-center justify-center rounded-full transition-[color,background-color,box-shadow] duration-150 ease-enter group-focus-visible:ring-4 group-focus-visible:ring-primary/16 [&_svg]:size-5',
          active
            ? 'bg-selected text-selected-foreground'
            : 'text-muted-foreground group-hover:bg-accent group-hover:text-foreground',
        )}
      >
        {icon}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'line-clamp-2 w-full text-center text-xs leading-tight break-words',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {label}
      </span>
    </button>
  );
}

export { NavRail, NavRailItem };
