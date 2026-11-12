import type { UserError } from './errors.ts';

export function ErrorNotice({ error }: { error: UserError }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
    >
      <p className="font-medium text-destructive">{error.what}</p>
      <p className="mt-1 text-muted-foreground">{error.why}</p>
      <p className="mt-1">{error.next}</p>
    </div>
  );
}
