import type { ComponentProps } from 'react';

import { CheckIcon } from '../icons.tsx';
import { cn } from '../lib/utils.ts';

type CheckboxProps = Omit<ComponentProps<'button'>, 'role' | 'type'> & {
  checked: boolean;
};

/** A round check mark button. Display only: the parent owns the checked state. */
function Checkbox({ checked, className, ...props }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={cn(
        'press flex size-[22px] shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        checked
          ? 'bg-foreground text-background'
          : 'border-[1.5px] border-foreground/30 bg-card shadow-soft',
        className,
      )}
      {...props}
    >
      {checked && <CheckIcon className="size-3.5" />}
    </button>
  );
}

export { Checkbox };
