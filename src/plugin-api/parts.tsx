import { useState, type ReactNode } from "react"
import { ChevronRight, MessageCircle, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

/** The chip row every tab hangs its filters in. */
export function FilterBar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-b px-3 py-1.5"
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  )
}

export function TabEmpty({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <Empty className="border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Icon /></EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** Closed work folds away under whatever is still open. */
export function ClosedFold({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex h-7 w-full items-center gap-1.5 rounded-sm px-1 text-left text-xs text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/20"
        aria-expanded={open}
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        Closed
        <span className="font-mono text-[10px] tabular-nums opacity-70">{count}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-4 pt-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function CommentCount({ count }: { count: number }) {
  if (count === 0) return null
  const label = `${count} comment${count === 1 ? "" : "s"}`
  return (
    <span
      className="flex items-center gap-0.5 font-mono text-[10px] text-muted-foreground tabular-nums"
      aria-label={label}
      title={label}
    >
      <MessageCircle className="size-3" aria-hidden />
      {count}
    </span>
  )
}
