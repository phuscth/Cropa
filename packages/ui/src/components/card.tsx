import type { ComponentProps } from 'react';

import { cn } from '../lib/utils.ts';

/** A raised group with a soft shadow; rows inside it are separated by 1px dividers. */
function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn(
        'divide-y divide-border rounded-xl bg-card text-card-foreground shadow-soft',
        className,
      )}
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

/** A flat group with a 1px border and label and value rows, for read-only details. */
function DetailsCard({ className, ...props }: ComponentProps<'dl'>) {
  return (
    <dl
      data-slot="details-card"
      className={cn('flex flex-col gap-1.5 rounded-xl border p-3 text-[12px]', className)}
      {...props}
    />
  );
}

/** One label and value row of a details card. */
function DetailsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-caption">{label}</dt>
      <dd className="text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

export { Card, CardRow, DetailsCard, DetailsRow };
