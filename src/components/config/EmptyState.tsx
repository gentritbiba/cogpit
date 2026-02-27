import { FileText } from "lucide-react"

export function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
      <div className="flex items-center gap-2 text-muted-foreground/30">
        <FileText className="size-8" />
      </div>
      <p className="text-sm">Select a config to view or edit</p>
      <p className="text-xs text-muted-foreground/40 max-w-[260px] text-center">
        Browse your Claude configuration — instructions, agents, skills, commands, and settings
      </p>
    </div>
  )
}
