/**
 * Shared look of text fields and select triggers: 40px high, 12px radius, a
 * darker border on hover and a 4px primary halo on focus.
 */
export const fieldClasses =
  'h-10 w-full min-w-0 rounded-lg border border-input bg-card px-3.5 text-sm outline-none transition-[color,border-color,box-shadow] duration-150 ease-enter placeholder:text-muted-foreground hover:border-foreground/30 focus-visible:border-[color-mix(in_srgb,var(--input),var(--primary)_60%)] focus-visible:ring-4 focus-visible:ring-primary/16 disabled:pointer-events-none disabled:opacity-50 dark:bg-background';
