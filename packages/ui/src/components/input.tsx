import type { ComponentProps } from 'react';

import { fieldClasses } from '../lib/field.ts';
import { cn } from '../lib/utils.ts';

function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(fieldClasses, className)} {...props} />;
}

export { Input };
