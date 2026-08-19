import { useState, memo } from "react"
import { ChevronRight, ChevronDown, Minimize2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

export const CompactionMarker = memo(function CompactionMarker({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false)

  const lines = summary.split("\n")
  const title = lines[0].replace(/^\*\*|\*\*$/g, "")
  const details = lines.slice(1)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="px-4 py-2">
      <CollapsibleTrigger render={<Button type="button" variant="ghost" className="group h-auto w-full gap-3 px-0" />}>
        <div className="h-px flex-1 bg-border" />
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
          {open ? <ChevronDown className="size-3" data-icon="inline-start" /> : <ChevronRight className="size-3" data-icon="inline-start" />}
          <Minimize2 className="size-3" data-icon="inline-start" />
          <span className="font-medium">Compacted</span>
          <span>&middot;</span>
          <span className="italic">{title}</span>
        </div>
        <div className="h-px flex-1 bg-border" />
      </CollapsibleTrigger>

      <CollapsibleContent>
      {details.length > 0 && (
        <div className="mx-8 mt-2 flex flex-col gap-0.5 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {details.map((line, i) => (
            <div key={i} className={cn(
              line.startsWith("- ") && "pl-2 text-muted-foreground",
              line.startsWith("Tools:") && "text-foreground font-medium",
              line.startsWith("Prompts:") && "text-foreground font-medium mt-1",
              line.match(/^\d+ turns/) && "text-foreground",
            )}>
              {line}
            </div>
          ))}
        </div>
      )}
      </CollapsibleContent>
    </Collapsible>
  )
})
