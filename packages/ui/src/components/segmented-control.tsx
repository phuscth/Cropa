import { ToggleGroup } from 'radix-ui';
import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react';

import { cn } from '../lib/utils.ts';

type SegmentedControlProps = Omit<
  ComponentProps<typeof ToggleGroup.Root>,
  'type' | 'value' | 'defaultValue' | 'onValueChange' | 'ref'
> & {
  /** The selected item, or `undefined` when none matches. */
  value: string | undefined;
  onValueChange: (value: string) => void;
  /** `tab` sets the labels in the 16px tab type; the default is the 15px control type. */
  size?: 'default' | 'tab';
};

interface Indicator {
  x: number;
  width: number;
}

/**
 * One item is selected at a time; clicking the selected item keeps it selected.
 * A single raised pill slides to the selected item. The toggle group stays the
 * semantics and the keyboard; the pill only follows the measured item.
 */
function SegmentedControl({
  className,
  value,
  onValueChange,
  size = 'default',
  children,
  ...props
}: SegmentedControlProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  // The first placement is not animated: the pill should not fly in from the corner.
  const [placed, setPlaced] = useState(false);
  // True while the control is not laid out (a hidden view measures as zero).
  const hidden = useRef(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      // A hidden control measures as zero: keep the last place, and when it shows again put the
      // pill there at once instead of sliding it in from the corner.
      if (root.offsetWidth === 0) {
        hidden.current = true;
        return;
      }
      if (hidden.current) {
        hidden.current = false;
        setPlaced(false);
      }
      const item = root.querySelector<HTMLElement>('[data-state="on"]');
      setIndicator((previous) => {
        if (!item) return previous === null ? previous : null;
        const next = { x: item.offsetLeft, width: item.offsetWidth };
        return previous && previous.x === next.x && previous.width === next.width ? previous : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const item of root.querySelectorAll('[data-slot="segmented-control-item"]')) {
      observer.observe(item);
    }
    return () => { observer.disconnect(); };
  }, [value, children]);

  useLayoutEffect(() => {
    if (indicator === null || placed) return;
    const frame = requestAnimationFrame(() => { setPlaced(true); });
    return () => { cancelAnimationFrame(frame); };
  }, [indicator, placed]);

  return (
    <ToggleGroup.Root
      ref={rootRef}
      data-slot="segmented-control"
      data-size={size}
      type="single"
      value={value ?? ''}
      onValueChange={(next) => {
        if (next !== '') onValueChange(next);
      }}
      className={cn(
        'group/segmented relative grid h-9 w-full auto-cols-fr grid-flow-col rounded-[11px] bg-secondary p-[3px]',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        data-slot="segmented-control-indicator"
        className={cn(
          'pointer-events-none absolute inset-y-[3px] left-0 rounded-[8px] bg-card shadow-soft dark:bg-foreground/15',
          placed && 'transition-[transform,width] duration-200 ease-enter',
        )}
        style={
          indicator
            ? { width: indicator.width, transform: `translateX(${String(indicator.x)}px)` }
            : { opacity: 0 }
        }
      />
      {children}
    </ToggleGroup.Root>
  );
}

function SegmentedControlItem({ className, ...props }: ComponentProps<typeof ToggleGroup.Item>) {
  return (
    <ToggleGroup.Item
      data-slot="segmented-control-item"
      className={cn(
        'focus-ring relative z-10 inline-flex h-full min-w-0 items-center justify-center rounded-[8px] px-3 text-control whitespace-nowrap text-muted-foreground transition-colors duration-150 ease-enter group-data-[size=tab]/segmented:text-tab hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export { SegmentedControl, SegmentedControlItem };
