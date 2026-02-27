import { useState, memo } from "react"
import { ChevronRight, ChevronDown, Minimize2 } from "lucide-react"
import { cn } from "@/lib/utils"

export const CompactionMarker = memo(function CompactionMarker({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false)

  const lines = summary.split("\n")
  const title = lines[0].replace(/^\*\*|\*\*$/g, "")
  const details = lines.slice(1)

  return (
    <div className="px-4 py-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-3 w-full group"
      >
        <div className="flex-1 h-px bg-amber-500/20" />
        <div className="flex items-center gap-1.5 text-[11px] text-amber-500/70 group-hover:text-amber-400 transition-colors">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <Minimize2 className="size-3" />
          <span className="font-medium">Compacted</span>
          <span className="text-amber-500/50">&middot;</span>
          <span className="text-amber-500/50 italic">{title}</span>
        </div>
        <div className="flex-1 h-px bg-amber-500/20" />
      </button>

      {open && details.length > 0 && (
        <div className="mt-2 mx-8 rounded-md border border-amber-500/10 bg-amber-500/5 px-3 py-2 text-[11px] text-muted-foreground space-y-0.5">
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
    </div>
  )
})
