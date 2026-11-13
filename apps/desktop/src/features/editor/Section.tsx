import type { ReactNode } from 'react';

/**
 * A block of the editor panel under a small uppercase label. `actions` sit at
 * the right of the label row.
 */
export function Section({
  title,
  actions,
  id,
  children,
}: {
  title: string;
  actions?: ReactNode;
  /** An anchor, so another part of the panel can scroll the section into view. */
  id?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-3 flex-col gap-2.5">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <h3 className="text-section">{title}</h3>
        {actions && <div className="-my-1.5 flex items-center gap-1">{actions}</div>}
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
    <div className="flex flex-col gap-1.5">
      <div className="text-caption flex items-baseline justify-between gap-2">
        <span>{label}</span>
        {value !== undefined && <span className="tabular-nums">{value}</span>}
      </div>
      {children}
    </div>
  );
}
