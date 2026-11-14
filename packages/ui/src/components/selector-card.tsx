import type { ComponentProps, ReactNode } from 'react';

import { ChevronDownIcon } from '../icons.tsx';
import { cn } from '../lib/utils.ts';

interface SelectorCardProps extends Omit<ComponentProps<'button'>, 'title'> {
  /** The 15px line. */
  title: string;
  /** The 11px line under it. */
  caption?: string;
  /** A thumbnail before the text. */
  thumbnail?: ReactNode;
}

/**
 * A full-width 48px card that shows the current choice and opens or reveals
 * where to change it: raised colour with a soft shadow, a chevron at the end.
 */
function SelectorCard({ className, title, caption, thumbnail, ...props }: SelectorCardProps) {
  return (
    <button
      type="button"
      data-slot="selector-card"
      className={cn(
        'group press focus-ring flex h-12 w-full min-w-0 items-center gap-2.5 rounded-xl bg-card px-2.5 text-left text-card-foreground shadow-soft hover:shadow-soft-hover disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {thumbnail ? (
        <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-secondary">
          {thumbnail}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-control leading-tight">{title}</span>
        {caption ? <span className="text-caption truncate leading-tight">{caption}</span> : null}
      </span>
      <ChevronDownIcon className="size-4 shrink-0 text-tertiary-foreground transition-transform duration-200 ease-enter group-data-[state=open]:rotate-180" />
    </button>
  );
}

export { SelectorCard };
