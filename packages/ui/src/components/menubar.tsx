import { Menubar as MenubarPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '../lib/utils.ts';

const itemClass =
  'relative flex h-9 cursor-default items-center gap-2 rounded-md px-2.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground';

const contentClass =
  'z-50 min-w-40 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg';

/** A row of menus: hovering moves between open menus, and Left and Right switch them. */
function Menubar({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Root>) {
  return (
    <MenubarPrimitive.Root
      data-slot="menubar"
      className={cn('flex items-center gap-0.5', className)}
      {...props}
    />
  );
}

function MenubarMenu(props: ComponentProps<typeof MenubarPrimitive.Menu>) {
  return <MenubarPrimitive.Menu {...props} />;
}

function MenubarTrigger({
  className,
  ...props
}: ComponentProps<typeof MenubarPrimitive.Trigger>) {
  return (
    <MenubarPrimitive.Trigger
      data-slot="menubar-trigger"
      className={cn(
        'h-7 rounded-md px-2.5 text-sm text-muted-foreground outline-none transition-colors duration-150 ease-enter hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

function MenubarContent({
  className,
  align = 'start',
  sideOffset = 4,
  ...props
}: ComponentProps<typeof MenubarPrimitive.Content>) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.Content
        data-slot="menubar-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(contentClass, className)}
        {...props}
      />
    </MenubarPrimitive.Portal>
  );
}

function MenubarItem({ className, ...props }: ComponentProps<typeof MenubarPrimitive.Item>) {
  return <MenubarPrimitive.Item data-slot="menubar-item" className={cn(itemClass, className)} {...props} />;
}

function MenubarSeparator({
  className,
  ...props
}: ComponentProps<typeof MenubarPrimitive.Separator>) {
  return (
    <MenubarPrimitive.Separator
      data-slot="menubar-separator"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

/** The key combination of an item, pushed to the right edge of the row. */
function MenubarShortcut({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="menubar-shortcut"
      className={cn('ml-auto pl-6 text-xs text-muted-foreground', className)}
      {...props}
    />
  );
}

function MenubarRadioGroup(props: ComponentProps<typeof MenubarPrimitive.RadioGroup>) {
  return <MenubarPrimitive.RadioGroup {...props} />;
}

/** A choice among its siblings; the chosen one shows a check at the left. */
function MenubarRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenubarPrimitive.RadioItem>) {
  return (
    <MenubarPrimitive.RadioItem
      data-slot="menubar-radio-item"
      className={cn(itemClass, 'pr-2.5 pl-8', className)}
      {...props}
    >
      <span className="absolute left-2.5 flex size-4 items-center justify-center">
        <MenubarPrimitive.ItemIndicator>
          <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true">
            <path d="M6.5 11.5 3 8l1.1-1.1 2.4 2.4 5.4-5.4L13 5z" />
          </svg>
        </MenubarPrimitive.ItemIndicator>
      </span>
      {children}
    </MenubarPrimitive.RadioItem>
  );
}

function MenubarSub(props: ComponentProps<typeof MenubarPrimitive.Sub>) {
  return <MenubarPrimitive.Sub {...props} />;
}

function MenubarSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof MenubarPrimitive.SubTrigger>) {
  return (
    <MenubarPrimitive.SubTrigger
      data-slot="menubar-sub-trigger"
      className={cn(itemClass, 'data-[state=open]:bg-accent', className)}
      {...props}
    >
      {children}
      <svg viewBox="0 0 16 16" className="ml-auto size-4" fill="currentColor" aria-hidden="true">
        <path d="M6 3.5 10.5 8 6 12.5 5 11.5 8.5 8 5 4.5z" />
      </svg>
    </MenubarPrimitive.SubTrigger>
  );
}

function MenubarSubContent({
  className,
  ...props
}: ComponentProps<typeof MenubarPrimitive.SubContent>) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.SubContent
        data-slot="menubar-sub-content"
        className={cn(contentClass, className)}
        {...props}
      />
    </MenubarPrimitive.Portal>
  );
}

export {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
};
