import type { ComponentProps } from 'react';

import { cn } from '../lib/utils.ts';

/** A bordered group; rows inside it are separated by dividers. */
function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn('divide-y rounded-xl border bg-card text-card-foreground', className)}
      {...props}
    />
  );
}

/** Label and description on the left, the control on the right. */
function CardRow({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-row"
      className={cn('flex items-center justify-between gap-6 px-5 py-4', className)}
      {...props}
    />
  );
}

export { Card, CardRow };
