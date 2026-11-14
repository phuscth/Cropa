import type { ReactNode } from 'react';

interface Props {
  /** Whether the chosen provider is ready. */
  enabled: boolean;
  /** Why the control is off and what to do; shown while it is. */
  hint?: string | undefined;
  /** Renders the AI control; `enabled` is false until the chosen provider is ready. */
  children: (enabled: boolean) => ReactNode;
}

/** Shows an AI control disabled, with a hint, until a provider is ready. */
export function AiGate({ enabled, hint, children }: Props) {
  return (
    <div className="flex flex-col items-start gap-1">
      {children(enabled)}
      {!enabled && hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}
