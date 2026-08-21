import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs relative flex gap-2 data-[orientation=horizontal]:flex-col",
        "has-[>[data-slot=tabs-content]]:grid has-[>[data-slot=tabs-content]]:grid-cols-1 [&>[data-slot=tabs-list]]:col-start-1 [&>[data-slot=tabs-list]]:row-start-1 [&>[data-slot=tabs-content]]:col-start-1 [&>[data-slot=tabs-content]]:row-start-2",
        "data-[orientation=vertical]:has-[>[data-slot=tabs-content]]:grid-cols-[auto_minmax(0,1fr)] data-[orientation=vertical]:[&>[data-slot=tabs-content]]:col-start-2 data-[orientation=vertical]:[&>[data-slot=tabs-content]]:row-start-1",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-8 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  children,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        tabsListVariants({ variant }),
        "relative isolate",
        className
      )}
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        data-slot="tabs-indicator"
        data-variant={variant}
        className={cn(
          "pointer-events-none absolute top-0 left-0 z-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) translate-y-(--active-tab-top) transition-[translate,width,height] duration-150 ease-out motion-reduce:transition-none after:absolute after:content-['']",
          "data-[variant=default]:after:inset-0 data-[variant=default]:after:rounded-md data-[variant=default]:after:bg-background data-[variant=default]:after:shadow-sm",
          "data-[variant=line]:after:bg-foreground data-[variant=line]:data-[orientation=horizontal]:after:inset-x-0 data-[variant=line]:data-[orientation=horizontal]:after:-bottom-[5px] data-[variant=line]:data-[orientation=horizontal]:after:h-0.5 data-[variant=line]:data-[orientation=vertical]:after:inset-y-0 data-[variant=line]:data-[orientation=vertical]:after:-right-1 data-[variant=line]:data-[orientation=vertical]:after:w-0.5"
        )}
      />
    </TabsPrimitive.List>
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative z-10 inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 outline-none transition-[color,border-color,box-shadow,transform,scale] duration-100 ease-out group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground active:scale-[0.98] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:text-foreground dark:text-muted-foreground dark:hover:text-foreground dark:data-active:text-foreground motion-reduce:transition-none motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        "flex-1 text-sm outline-none transition-[opacity,translate] duration-150 ease-out motion-safe:data-starting-style:opacity-0 motion-safe:data-ending-style:opacity-0 motion-reduce:transition-none",
        "motion-safe:data-starting-style:data-[activation-direction=left]:translate-x-[-0.25rem] motion-safe:data-starting-style:data-[activation-direction=right]:translate-x-[0.25rem] motion-safe:data-ending-style:data-[activation-direction=left]:translate-x-[0.25rem] motion-safe:data-ending-style:data-[activation-direction=right]:translate-x-[-0.25rem]",
        "motion-safe:data-starting-style:data-[activation-direction=up]:translate-y-[-0.25rem] motion-safe:data-starting-style:data-[activation-direction=down]:translate-y-[0.25rem] motion-safe:data-ending-style:data-[activation-direction=up]:translate-y-[0.25rem] motion-safe:data-ending-style:data-[activation-direction=down]:translate-y-[-0.25rem]",
        className
      )}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
