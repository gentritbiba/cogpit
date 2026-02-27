import { Globe, FolderCode, Plug } from "lucide-react"

interface ScopeBadgeProps {
  scope: string
  pluginName?: string
}

export function ScopeBadge({ scope, pluginName }: ScopeBadgeProps) {
  if (scope === "plugin" && pluginName) {
    return (
      <span className="flex items-center gap-0.5 text-[9px] text-purple-400/70 shrink-0">
        <Plug className="size-2.5" />
        {pluginName}
      </span>
    )
  }
  if (scope === "project") {
    return (
      <span className="flex items-center gap-0.5 text-[9px] text-green-400/70 shrink-0">
        <FolderCode className="size-2.5" />
        project
      </span>
    )
  }
  return (
    <span className="flex items-center gap-0.5 text-[9px] text-blue-400/50 shrink-0">
      <Globe className="size-2.5" />
      global
    </span>
  )
}
