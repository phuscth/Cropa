import { Slider as SliderPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/utils.ts';

type SliderFieldProps = ComponentProps<typeof SliderPrimitive.Root> & {
  /** The single value, in a one-item array like Radix. */
  value: number[];
  /** Shown inside the track, on the left; also the thumb's accessible name. */
  label: string;
  /** Shown inside the track, on the right; also the thumb's `aria-valuetext`. */
  valueText: string;
};

/**
 * A single-thumb slider drawn as one rounded pill, 30px tall: the filled part
 * is the raised colour and follows the pointer with no transition, a thin bar
 * marks its edge, the label sits inside on the left and the value on the right.
 * The whole pill takes clicks and drags. The thumb is a 22px box that carries
 * the bar and the keyboard and screen-reader behaviour; the fill always ends
 * just past the bar, so every value looks different. `value` is a one-item
 * array, like Radix, and is required.
 */
function SliderField({ className, label, valueText, value, min = 0, max = 100, ...props }: SliderFieldProps) {
  const fraction = max === min ? 0 : Math.min(1, Math.max(0, ((value[0] ?? min) - min) / (max - min)));
  return (
    <SliderPrimitive.Root
      data-slot="slider-field"
      className={cn(
        'relative flex h-[30px] w-full touch-none items-center rounded-full select-none has-[[role=slider]:focus-visible]:outline-2 has-[[role=slider]:focus-visible]:outline-offset-2 has-[[role=slider]:focus-visible]:outline-ring data-[disabled]:opacity-50',
        className,
      )}
      value={value}
      min={min}
      max={max}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-field-track"
        className="absolute inset-0 overflow-hidden rounded-full bg-secondary"
      >
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-card shadow-[0_1.5px_6px_-3px_rgba(0,0,0,0.4)] dark:bg-foreground/20"
          style={{ width: `calc(16px + (100% - 22px) * ${String(fraction)})` }}
        />
      </SliderPrimitive.Track>
      <span aria-hidden="true" className="pointer-events-none absolute inset-x-3.5 z-10 flex items-center justify-between gap-2 text-[11px] leading-[1.3] font-medium tracking-[-0.2px]">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{valueText}</span>
      </span>
      <SliderPrimitive.Thumb
        data-slot="slider-field-thumb"
        aria-label={label}
        aria-valuetext={valueText}
        className="relative block h-[30px] w-[22px] outline-none after:absolute after:top-1/2 after:left-1/2 after:h-[18px] after:w-0.5 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:bg-foreground/45"
      />
    </SliderPrimitive.Root>
  );
}

export { SliderField };
