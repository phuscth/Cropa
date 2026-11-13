import type { ReactNode } from 'react';

/** A titled block of the sidebar. `actions` sit at the right of the title row. */
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
    <section className="flex flex-col gap-4 border-b px-5 py-4 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
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
