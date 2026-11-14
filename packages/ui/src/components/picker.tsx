import { Popover as PopoverPrimitive, ToggleGroup } from 'radix-ui';
import { useId, useRef, type ComponentProps, type ReactNode } from 'react';

import { isDrag, restingScroll } from '../lib/drag-scroll.ts';
import { cn } from '../lib/utils.ts';

type PickerContentProps = ComponentProps<typeof PopoverPrimitive.Content> & {
  /** Stays at the top while the rest scrolls, for example the filter pills. */
  header?: ReactNode;
};

/**
 * A large dropdown for choosing among many cards: raised colour, 20px radius, at most 60% of
 * the window's height (less if the window leaves less room) with the cards scrolling under a
 * fixed header, scaling in from its trigger and back out on close.
 */
function PickerContent({
  className,
  header,
  children,
  align = 'start',
  sideOffset = 6,
  collisionPadding = 6,
  ...props
}: PickerContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="picker-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-50 flex max-h-[min(60vh,var(--radix-popover-content-available-height))] w-[440px] max-w-[calc(100vw-12px)] origin-(--radix-popover-content-transform-origin) flex-col overflow-hidden rounded-[20px] bg-popover text-popover-foreground shadow-menu outline-none data-[state=closed]:animate-menu-out data-[state=open]:animate-menu-in',
          className,
        )}
        {...props}
      >
        {header ? <div className="shrink-0 px-4 pt-4 pb-3">{header}</div> : null}
        <div
          data-slot="picker-scroll"
          className={cn('flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain pb-4', !header && 'pt-4')}
        >
          {children}
        </div>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

type PickerPillsProps = Omit<
  ComponentProps<typeof ToggleGroup.Root>,
  'type' | 'value' | 'defaultValue' | 'onValueChange'
> & {
  value: string;
  onValueChange: (value: string) => void;
};

/** A row of pills, one active at a time (never none). It scrolls sideways instead of wrapping. */
function PickerPills({ className, value, onValueChange, ...props }: PickerPillsProps) {
  return (
    <ToggleGroup.Root
      data-slot="picker-pills"
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next !== '') onValueChange(next);
      }}
      className={cn('flex gap-2 overflow-x-auto p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)}
      {...props}
    />
  );
}

function PickerPill({ className, ...props }: ComponentProps<typeof ToggleGroup.Item>) {
  return (
    <ToggleGroup.Item
      data-slot="picker-pill"
      className={cn(
        'press focus-ring h-[34px] shrink-0 rounded-full bg-secondary px-4 text-control-sm whitespace-nowrap text-secondary-foreground hover:bg-secondary/70 dark:hover:bg-foreground/10 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary dark:data-[state=on]:hover:bg-primary',
        className,
      )}
      {...props}
    />
  );
}

interface PickerSectionProps {
  title: string;
  /** Buttons at the right of the heading, before "See all". */
  actions?: ReactNode | undefined;
  /** When set, a "See all" pill is shown. */
  onSeeAll?: (() => void) | undefined;
  seeAllLabel?: string;
  children: ReactNode;
}

/** A headed block of the picker: a 20px heading with its actions, then the cards. */
function PickerSection({ title, actions, onSeeAll, seeAllLabel, children }: PickerSectionProps) {
  const headingId = useId();
  return (
    <section data-slot="picker-section" aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2 px-4">
        <h3 id={headingId} className="min-w-0 truncate text-[20px] leading-tight font-medium tracking-[-0.6px]">
          {title}
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {onSeeAll ? (
            <button
              type="button"
              onClick={onSeeAll}
              className="press focus-ring h-7 rounded-full bg-secondary px-3 text-[13px] leading-none font-medium tracking-[-0.2px] hover:bg-secondary/70 dark:hover:bg-foreground/10"
            >
              {seeAllLabel}
            </button>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}

interface RowDrag {
  pointerId: number;
  startX: number;
  startY: number;
  startScroll: number;
  dragging: boolean;
  /** Recent pointer positions, for the speed at release. */
  samples: { x: number; t: number }[];
}

/** Only the last stretch of a drag counts towards the speed it was let go with. */
const VELOCITY_WINDOW_MS = 80;

/** The scroll positions the row's snap points rest at, as CSS `snap-start` places them. */
function snapPositions(row: HTMLElement): number[] {
  const rowLeft = row.getBoundingClientRect().left;
  const padding = Number.parseFloat(getComputedStyle(row).scrollPaddingLeft) || 0;
  return [...row.children]
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child.dataset.slot === 'picker-card')
    .map((card) => row.scrollLeft + card.getBoundingClientRect().left - rowLeft - row.clientLeft - padding);
}

/** Pointer pixels per millisecond over the last moments before `now`; 0 if it had stopped. */
function releaseSpeed(samples: readonly { x: number; t: number }[], now: number): number {
  const recent = samples.filter((sample) => now - sample.t <= VELOCITY_WINDOW_MS);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last || last.t - first.t <= 0) return 0;
  return (last.x - first.x) / (last.t - first.t);
}

/**
 * One row of cards that scrolls sideways: by wheel or trackpad, and by pressing and dragging
 * with a mouse. A press that moves past a few pixels scrolls the row and does not click
 * the card it started on; on release the row glides on with the drag's speed and settles on a
 * card edge (at once under reduced motion). A press a control already handled, such as a menu
 * button that opens on pointer down, is left to it.
 */
function PickerRow({
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onClickCapture,
  ...props
}: ComponentProps<'div'>) {
  const drag = useRef<RowDrag | null>(null);
  const swallowClick = useRef(false);

  const end = (row: HTMLDivElement, pointerId: number, now: number) => {
    const current = drag.current;
    if (current?.pointerId !== pointerId) return;
    drag.current = null;
    if (!current.dragging) return;
    row.removeAttribute('data-dragging');
    // The click that follows this release belongs to the drag. It fires right after the
    // pointer up, before any timer, so the flag is cleared before a later keyboard click.
    swallowClick.current = true;
    setTimeout(() => {
      swallowClick.current = false;
    }, 0);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const left = restingScroll(
      row.scrollLeft,
      reduce ? 0 : releaseSpeed(current.samples, now),
      snapPositions(row),
      row.scrollWidth - row.clientWidth,
    );
    if (reduce || Math.abs(left - row.scrollLeft) < 1) {
      row.scrollTo({ left, behavior: 'instant' });
      return;
    }
    // Snapping stays off until the row has settled, so it cannot pick a different card
    // half way through the glide. The glide ends on a snap point, where snapping agrees.
    row.setAttribute('data-gliding', '');
    row.addEventListener('scrollend', () => { row.removeAttribute('data-gliding'); }, { once: true });
    row.scrollTo({ left, behavior: 'smooth' });
  };

  return (
    <div
      data-slot="picker-row"
      className={cn(
        'flex cursor-grab snap-x snap-proximity scroll-px-4 gap-3 overflow-x-auto px-4 pt-1.5 pb-3',
        // While dragging, snapping would pull against the pointer, and the cards under it must
        // neither lift on hover, stay pressed, nor show their own cursor.
        'data-dragging:cursor-grabbing data-dragging:snap-none data-dragging:select-none data-gliding:snap-none [&[data-dragging]_*]:pointer-events-none [&[data-dragging]_*]:[--press-scale:1]',
        className,
      )}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        swallowClick.current = false;
        // Touch and pen already pan the row natively.
        if (event.defaultPrevented || event.button !== 0 || event.pointerType !== 'mouse') return;
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startScroll: event.currentTarget.scrollLeft,
          dragging: false,
          samples: [{ x: event.clientX, t: event.timeStamp }],
        };
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        const current = drag.current;
        if (current?.pointerId !== event.pointerId) return;
        const row = event.currentTarget;
        if (!current.dragging) {
          if (!isDrag(event.clientX - current.startX, event.clientY - current.startY)) return;
          current.dragging = true;
          // Counted from here, so a row still gliding from a flick is caught where it is
          // instead of jumping back to where it was when pressed.
          current.startX = event.clientX;
          current.startScroll = row.scrollLeft;
          // Captured so the drag follows the pointer, and ends, even outside the row.
          row.setPointerCapture(event.pointerId);
          row.setAttribute('data-dragging', '');
        }
        row.scrollLeft = current.startScroll - (event.clientX - current.startX);
        current.samples.push({ x: event.clientX, t: event.timeStamp });
        while (current.samples.length > 2 && event.timeStamp - (current.samples[0]?.t ?? 0) > VELOCITY_WINDOW_MS) {
          current.samples.shift();
        }
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        end(event.currentTarget, event.pointerId, event.timeStamp);
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event);
        end(event.currentTarget, event.pointerId, event.timeStamp);
      }}
      onLostPointerCapture={(event) => {
        onLostPointerCapture?.(event);
        end(event.currentTarget, event.pointerId, event.timeStamp);
      }}
      onClickCapture={(event) => {
        if (swallowClick.current) {
          swallowClick.current = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClickCapture?.(event);
      }}
      {...props}
    />
  );
}

/** The same cards in two columns. */
function PickerGrid({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="picker-grid"
      className={cn('grid grid-cols-2 gap-3 px-4 py-1.5 [&>[data-slot=picker-card]]:w-full', className)}
      {...props}
    />
  );
}

type PickerCardProps = Omit<ComponentProps<'button'>, 'title'> & {
  /** The 17px line; truncated. */
  title: string;
  /** The 12px line under it; truncated. */
  caption?: string;
  /** Small pills at the top right, such as "New". */
  badges?: readonly string[];
  /** Marks the card as the current choice: a 1px ring in the text colour. */
  selected?: boolean;
  /** The preview, drawn at the full width of the card in 4:3. */
  children: ReactNode;
  /** Positioned over the card, as a sibling of its button (a menu button, say). */
  overlay?: ReactNode;
};

/**
 * A card 196 wide (about 205 high) in the panel colour: name, caption and badges close above a
 * preview inset by the same 16px on every side, its corners following the card's. Hover lifts
 * it 1px; press scales it; the selected card grows a ring from its edge.
 * Extra props, such as `data-testid`, go to the button.
 */
function PickerCard({
  className,
  title,
  caption,
  badges,
  selected = false,
  children,
  overlay,
  ...props
}: PickerCardProps) {
  return (
    <div
      data-slot="picker-card"
      className="group/card relative flex w-[196px] shrink-0 snap-start rounded-[24px] transition-[translate,box-shadow] duration-150 ease-enter hover:-translate-y-px hover:shadow-soft-hover"
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'press focus-ring flex min-w-0 flex-1 flex-col gap-2.5 rounded-[24px] bg-panel p-4 text-left',
          className,
        )}
        {...props}
      >
        <span className="flex min-w-0 items-start justify-between gap-2">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[17px] leading-tight font-medium tracking-[-0.5px]">{title}</span>
            {caption ? (
              <span className="truncate text-[12px] leading-tight text-tertiary-foreground">{caption}</span>
            ) : null}
          </span>
          {badges && badges.length > 0 ? (
            <span className="flex shrink-0 gap-1">
              {badges.map((badge) => (
                <span
                  key={badge}
                  aria-hidden="true"
                  className="inline-flex h-[18px] items-center rounded-full bg-primary px-2 text-[11px] leading-none font-medium text-primary-foreground"
                >
                  {badge}
                </span>
              ))}
            </span>
          ) : null}
        </span>
        <span className="relative mt-auto block aspect-[4/3] w-full overflow-hidden rounded-[8px] bg-secondary">
          {children}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0 rounded-[24px] outline-1 outline-transparent outline-offset-[-4px] transition-[outline-color,outline-offset] duration-200 ease-enter',
            selected && 'outline-foreground outline-offset-0',
          )}
        />
      </button>
      {overlay}
    </div>
  );
}

export { PickerCard, PickerContent, PickerGrid, PickerPill, PickerPills, PickerRow, PickerSection };
