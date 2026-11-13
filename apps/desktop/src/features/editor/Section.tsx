import type { ReactNode } from 'react';

/**
 * A block of the editor panel under a small uppercase label. `actions` sit at
 * the right of the label row.
 */
export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
          {title}
        </h3>
        {actions && <div className="-my-1 flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Row({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>{label}</span>
        {value !== undefined && <span className="text-muted-foreground tabular-nums">{value}</span>}
      </div>
      {children}
    </div>
  );
}
