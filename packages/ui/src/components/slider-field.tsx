import { Slider as SliderPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/utils.ts';

type SliderFieldProps = ComponentProps<typeof SliderPrimitive.Root> & {
  /** Shown inside the track, on the left; also the thumb's accessible name. */
  label: string;
  /** Shown inside the track, on the right; also the thumb's `aria-valuetext`. */
  valueText: string;
};

/**
 * A single-thumb slider drawn as one rounded pill, 32px tall: the filled part
 * is the raised colour and follows the pointer with no transition, a thin bar
 * marks its edge, the label sits inside on the left and the value on the right.
 * The whole pill takes clicks and drags; the real thumb is invisible but keeps
 * the keyboard and screen-reader behaviour. Pass `value` as a one-item array,
 * like Radix.
 */
function SliderField({ className, label, valueText, ...props }: SliderFieldProps) {
  return (
    <SliderPrimitive.Root
      data-slot="slider-field"
      className={cn(
        'relative flex h-8 w-full touch-none items-center rounded-full select-none has-[[role=slider]:focus-visible]:outline-2 has-[[role=slider]:focus-visible]:outline-offset-2 has-[[role=slider]:focus-visible]:outline-ring data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-field-track"
        className="absolute inset-0 overflow-hidden rounded-full bg-secondary"
      >
        <SliderPrimitive.Range
          data-slot="slider-field-range"
          className="absolute h-full min-w-4 bg-card after:absolute after:top-1/2 after:right-[5px] after:h-4 after:w-0.5 after:-translate-y-1/2 after:rounded-full after:bg-foreground/45 dark:bg-foreground/15"
        />
      </SliderPrimitive.Track>
      <span aria-hidden="true" className="pointer-events-none absolute inset-x-3.5 z-10 flex items-center justify-between gap-2 text-control-sm">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{valueText}</span>
      </span>
      <SliderPrimitive.Thumb
        data-slot="slider-field-thumb"
        aria-label={label}
        aria-valuetext={valueText}
        className="block h-4 w-0.5 opacity-0 outline-none"
      />
    </SliderPrimitive.Root>
  );
}

export { SliderField };
