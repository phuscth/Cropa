import { Switch as SwitchPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/utils.ts';

function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'focus-ring inline-flex h-6 w-10 shrink-0 items-center rounded-full bg-foreground/20 p-0.5 transition-colors duration-200 ease-enter disabled:pointer-events-none disabled:opacity-50 data-[state=checked]:bg-ring',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-5 rounded-full bg-white shadow-soft transition-[transform,translate] duration-200 ease-enter data-[state=checked]:translate-x-4"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
