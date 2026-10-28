import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { CollapsibleTrigger } from "@/components/ui/collapsible"

interface SectionTriggerProps {
  icon: LucideIcon
  title: string
  summary: string
  open: boolean
}

/** The header of a collapsible settings section: its name, and on the right a one-line summary and the chevron. */
export function SectionTrigger({ icon: Icon, title, summary, open }: SectionTriggerProps) {
  return (
    <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-auto w-full justify-between px-0 font-medium hover:bg-transparent" />}>
      <span className="flex items-center gap-2">
        <Icon data-icon="inline-start" className="size-4 text-muted-foreground" />
        {title}
      </span>
      <span className="flex min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground">
        <span className="truncate">{summary}</span>
        {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
      </span>
    </CollapsibleTrigger>
  )
}
