import { Card, CardRow } from '@cropa/ui';
import { useId, type ReactNode } from 'react';

interface SectionProps {
  title: string;
  children: ReactNode;
}

/** A settings group: a heading above a card of rows. */
export function SettingsSection({ title, children }: SectionProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col">
      <h2 id={headingId} className="text-section mb-2 px-1">
        {title}
      </h2>
      <Card>{children}</Card>
    </section>
  );
}

interface RowIds {
  labelId: string;
  descriptionId: string;
}

interface RowProps {
  label: string;
  description?: string | undefined;
  /** Text shown beside the label, such as a status. */
  aside?: ReactNode;
  /** The control, or a function that receives the ids of the label and the description. */
  children: ReactNode | ((ids: RowIds) => ReactNode);
  /** Stack the control under the text instead of beside it. */
  stacked?: boolean;
}

/** Label and description on the left, the control on the right. */
export function SettingRow({ label, description, aside, children, stacked = false }: RowProps) {
  const id = useId();
  const ids = { labelId: `${id}-label`, descriptionId: `${id}-description` };
  return (
    <CardRow className={stacked ? 'flex-col items-stretch gap-3' : undefined}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-baseline gap-3">
          <span id={ids.labelId} className="text-control-sm">
            {label}
          </span>
          {aside}
        </div>
        {description && (
          <p id={ids.descriptionId} className="break-words text-[13px] leading-snug text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className={stacked ? 'min-w-0' : 'flex shrink-0 items-center gap-2'}>
        {typeof children === 'function' ? children(ids) : children}
      </div>
    </CardRow>
  );
}
