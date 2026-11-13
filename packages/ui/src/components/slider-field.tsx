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
 * A single-thumb slider drawn as a full-width 34px track: the filled part is
 * the raised colour and follows the pointer with no transition, the label sits
 * inside on the left and the value on the right. The whole track takes clicks
 * and drags. Pass `value` as a one-item array, like Radix.
 */
function SliderField({ className, label, valueText, ...props }: SliderFieldProps) {
  return (
    <SliderPrimitive.Root
      data-slot="slider-field"
      className={cn(
        'relative flex h-[34px] w-full touch-none items-center rounded-[10px] select-none has-[[role=slider]:focus-visible]:outline-2 has-[[role=slider]:focus-visible]:outline-offset-2 has-[[role=slider]:focus-visible]:outline-ring data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-field-track"
        className="absolute inset-0 overflow-hidden rounded-[10px] bg-secondary"
      >
        <SliderPrimitive.Range
          data-slot="slider-field-range"
          className="absolute h-full bg-card dark:bg-foreground/15"
        />
      </SliderPrimitive.Track>
      <span aria-hidden="true" className="pointer-events-none absolute inset-x-3 z-10 flex items-center justify-between gap-2 text-control-sm">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{valueText}</span>
      </span>
      <SliderPrimitive.Thumb
        data-slot="slider-field-thumb"
        aria-label={label}
        aria-valuetext={valueText}
        className="z-10 block h-5 w-0.5 shrink-0 rounded-full bg-foreground/40 outline-none"
      />
    </SliderPrimitive.Root>
  );
}

export { SliderField };
