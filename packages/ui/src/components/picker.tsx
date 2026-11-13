import { Popover as PopoverPrimitive, ToggleGroup } from 'radix-ui';
import { useId, type ComponentProps, type ReactNode } from 'react';

import { cn } from '../lib/utils.ts';

type PickerContentProps = ComponentProps<typeof PopoverPrimitive.Content> & {
  /** Stays at the top while the rest scrolls, for example the filter pills. */
  header?: ReactNode;
};

/**
 * A large dropdown for choosing among many cards: raised colour, 20px radius, up to the
 * height the window leaves, scaling in from its trigger and back out on close.
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
          'z-50 flex max-h-(--radix-popover-content-available-height) w-[440px] max-w-[calc(100vw-12px)] origin-(--radix-popover-content-transform-origin) flex-col overflow-hidden rounded-[20px] bg-popover text-popover-foreground shadow-menu outline-none data-[state=closed]:animate-menu-out data-[state=open]:animate-menu-in',
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
        'press focus-ring h-[34px] shrink-0 rounded-full bg-secondary px-4 text-control-sm whitespace-nowrap text-secondary-foreground hover:bg-secondary/70 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary',
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
              className="press focus-ring h-7 rounded-full bg-secondary px-3 text-[13px] leading-none font-medium tracking-[-0.2px] hover:bg-secondary/70"
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

/** One row of cards that scrolls sideways. */
function PickerRow({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="picker-row"
      className={cn('flex snap-x snap-proximity gap-3 overflow-x-auto px-4 pt-1.5 pb-3', className)}
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
 * A card about 196 by 248 in the panel colour: name, caption and badges above a large
 * preview. Hover lifts it 1px; press scales it; the selected card grows a ring from its edge.
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
      className="group/card relative h-[248px] w-[196px] shrink-0 snap-start rounded-2xl transition-[translate,box-shadow] duration-150 ease-enter hover:-translate-y-px hover:shadow-soft-hover"
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'press focus-ring flex size-full min-w-0 flex-col gap-2 rounded-2xl bg-panel p-3.5 text-left',
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
        <span className="relative mt-auto block aspect-[4/3] w-full overflow-hidden rounded-[10px] bg-secondary">
          {children}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0 rounded-2xl outline-1 outline-transparent outline-offset-[-4px] transition-[outline-color,outline-offset] duration-200 ease-enter',
            selected && 'outline-foreground outline-offset-0',
          )}
        />
      </button>
      {overlay}
    </div>
  );
}

export { PickerCard, PickerContent, PickerGrid, PickerPill, PickerPills, PickerRow, PickerSection };
