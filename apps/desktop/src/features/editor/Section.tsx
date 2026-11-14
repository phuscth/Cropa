import { ChevronDownIcon } from '@cropa/ui';
import { useId, type ReactNode } from 'react';

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
    <section id={id} className="flex scroll-mt-3 flex-col gap-2">
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

/**
 * A section whose body is folded away until its header is pressed. The body is `inert`
 * while closed, so Tab and screen readers skip it.
 */
export function CollapsibleSection({
  title,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const bodyId = useId();
  return (
    <section className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => { onOpenChange(!open); }}
        className="focus-ring flex min-h-5 w-full items-center justify-between gap-2 rounded-md text-left"
      >
        <span className="text-section">{title}</span>
        <ChevronDownIcon className={`size-4 shrink-0 text-tertiary-foreground transition-transform duration-200 ease-enter ${open ? 'rotate-180' : ''}`} />
      </button>
      <div
        id={bodyId}
        inert={!open}
        aria-hidden={!open}
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-enter ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
      >
        <div className="-mx-1 min-h-0 overflow-hidden">
          <div className="flex flex-col gap-2.5 px-1 pt-2 pb-1">{children}</div>
        </div>
      </div>
    </section>
  );
}
