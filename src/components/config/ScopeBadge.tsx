import { Globe, FolderCode, Plug } from "lucide-react"

interface ScopeBadgeProps {
  scope: string
  pluginName?: string
}

export function ScopeBadge({ scope, pluginName }: ScopeBadgeProps) {
  if (scope === "plugin" && pluginName) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Plug data-icon="inline-start" className="size-3" />
        {pluginName}
      </span>
    )
  }
  if (scope === "project") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <FolderCode data-icon="inline-start" className="size-3" />
        project
      </span>
    )
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <Globe data-icon="inline-start" className="size-3" />
      global
    </span>
  )
}
