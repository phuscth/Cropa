import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';

import { cn } from '../lib/utils.ts';

interface NavRailProps extends ComponentProps<'aside'> {
  /** An optional 32px mark above the items. */
  logo?: ReactNode;
  /** Items pinned to the bottom. */
  footer?: ReactNode;
}

/**
 * A 68px side rail on the window colour: items from the top, then a footer
 * pinned to the bottom. A 3px accent bar at the left edge slides to the active
 * item.
 */
function NavRail({ className, logo, footer, children, ...props }: NavRailProps) {
  const railRef = useRef<HTMLElement>(null);
  const [barTop, setBarTop] = useState<number | null>(null);
  // The bar does not travel from the corner on the first placement.
  const [placed, setPlaced] = useState(false);
  // True while the rail is not laid out; it then keeps its last place instead of measuring zero.
  const hidden = useRef(false);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const measure = () => {
      if (rail.offsetWidth === 0) {
        hidden.current = true;
        return;
      }
      if (hidden.current) {
        hidden.current = false;
        setPlaced(false);
      }
      const active = rail.querySelector<HTMLElement>('[aria-current="page"]');
      setBarTop(active ? active.offsetTop + (active.offsetHeight - 16) / 2 : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => { observer.disconnect(); };
  });

  useLayoutEffect(() => {
    if (barTop === null || placed) return;
    const frame = requestAnimationFrame(() => { setPlaced(true); });
    return () => { cancelAnimationFrame(frame); };
  }, [barTop, placed]);

  return (
    <aside
      ref={railRef}
      data-slot="nav-rail"
      className={cn(
        'relative z-20 flex w-17 shrink-0 flex-col items-center bg-sidebar pt-1.5 pb-3',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        data-slot="nav-rail-indicator"
        className={cn(
          'pointer-events-none absolute top-0 left-0 h-4 w-[3px] rounded-r-full bg-ring',
          placed && 'transition-transform duration-200 ease-enter',
        )}
        style={
          barTop === null
            ? { opacity: 0 }
            : { transform: `translateY(${String(barTop)}px)` }
        }
      />
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

/** A 44px square with a 20px icon; its name shows only as a tooltip. */
function NavRailItem({ className, icon, label, active = false, ...props }: NavRailItemProps) {
  return (
    <button
      type="button"
      data-slot="nav-rail-item"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'press focus-ring group relative flex size-11 items-center justify-center rounded-[10px] [&_svg]:size-5',
        active
          ? 'bg-selected text-foreground shadow-soft'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        className,
      )}
      {...props}
    >
      {icon}
      {/* The button's aria-label already names it, so the tooltip is visual only. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-full z-50 ml-2 -translate-y-1/2 rounded-md bg-foreground px-2 py-1 text-tiny whitespace-nowrap text-background opacity-0 shadow-md transition-opacity duration-150 ease-enter group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {label}
      </span>
    </button>
  );
}

export { NavRail, NavRailItem };
