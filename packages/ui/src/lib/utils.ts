import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // The type steps of tailwind.css set a size, weight and tracking; without this
      // they would be taken for text colours and drop or be dropped by a colour class.
      'font-size': [
        {
          text: ['tab', 'control', 'control-sm', 'tiny', 'section', 'caption', 'title', 'heading'],
        },
      ],
    },
  },
});

/** Merge class names; later Tailwind utilities win over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
