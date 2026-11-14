import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from '../lib/utils.ts';

interface SidebarNavItem {
  value: string;
  label: string;
  icon: ReactNode;
}

interface SidebarNavProps {
  /** The accessible name of the list. */
  'aria-label': string;
  items: readonly SidebarNavItem[];
  /** The item whose page is shown. */
  value: string;
  onValueChange: (value: string) => void;
  /** Size and placement; padding here would shift the pill off the items. */
  className?: string;
}

interface Indicator {
  y: number;
  height: number;
}

/**
 * A vertical list of pages, each an icon and a label; the current one is marked
 * with `aria-current` and a raised pill that slides between items. Tab reaches
 * the current item, the arrow keys, Home and End move between items, and Enter
 * or Space opens the focused one.
 */
function SidebarNav({ items, value, onValueChange, className, 'aria-label': label }: SidebarNavProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  // The first placement is not animated: the pill should not fly in from the top.
  const [placed, setPlaced] = useState(false);
  // True while the list is not laid out (a hidden view measures as zero).
  const hidden = useRef(false);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      // Keep the last place while hidden, and put the pill there at once when the list shows again.
      if (list.offsetHeight === 0) {
        hidden.current = true;
        return;
      }
      if (hidden.current) {
        hidden.current = false;
        setPlaced(false);
      }
      const item = list.querySelector<HTMLElement>('[aria-current="page"]');
      setIndicator((previous) => {
        if (!item) return previous === null ? previous : null;
        const next = { y: item.offsetTop, height: item.offsetHeight };
        return previous && previous.y === next.y && previous.height === next.height ? previous : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => { observer.disconnect(); };
  }, [value, items]);

  useLayoutEffect(() => {
    if (indicator === null || placed) return;
    const frame = requestAnimationFrame(() => { setPlaced(true); });
    return () => { cancelAnimationFrame(frame); };
  }, [indicator, placed]);

  const moveFocus = (event: KeyboardEvent<HTMLUListElement>) => {
    const list = listRef.current;
    if (!list) return;
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('[data-slot="sidebar-nav-item"]')];
    const index = buttons.findIndex((button) => button === document.activeElement);
    const count = buttons.length;
    if (index < 0 || count === 0) return;
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = (index + 1) % count;
        break;
      case 'ArrowUp':
        next = (index - 1 + count) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  };

  // Tab lands on the current item, or on the first when none matches.
  const tabStop = items.some((item) => item.value === value) ? value : items[0]?.value;

  return (
    <nav aria-label={label} data-slot="sidebar-nav" className={cn('relative', className)}>
      <span
        aria-hidden="true"
        data-slot="sidebar-nav-indicator"
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 rounded-[10px] bg-selected shadow-soft',
          placed && 'transition-[transform,height] duration-200 ease-enter',
        )}
        style={
          indicator
            ? { height: indicator.height, transform: `translateY(${String(indicator.y)}px)` }
            : { opacity: 0 }
        }
      />
      <ul ref={listRef} className="flex flex-col gap-0.5" onKeyDown={moveFocus}>
        {items.map((item) => {
          const active = item.value === value;
          return (
            <li key={item.value} className="flex">
              <button
                type="button"
                data-slot="sidebar-nav-item"
                aria-current={active ? 'page' : undefined}
                tabIndex={item.value === tabStop ? 0 : -1}
                onClick={() => { onValueChange(item.value); }}
                className={cn(
                  'press focus-ring relative z-10 flex h-9 w-full min-w-0 items-center gap-2.5 rounded-[10px] px-2.5 text-left text-control-sm [&_svg]:size-[18px] [&_svg]:shrink-0',
                  active
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {item.icon}
                <span className="min-w-0 truncate">{item.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export { SidebarNav, type SidebarNavItem };
