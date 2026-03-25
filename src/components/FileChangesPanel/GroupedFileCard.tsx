import { memo, useCallback } from "react"
import { Code2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { GitStatusBadge, SubAgentIndicator } from "./file-change-indicators"
import { openInEditor } from "./open-in-editor"
import type { GroupedFile } from "./useFileChangesData"

const EXT_COLORS: Record<string, string> = {
  tsx: "text-blue-400",
  jsx: "text-blue-400",
  ts: "text-yellow-400",
  js: "text-yellow-400",
  css: "text-purple-400",
  scss: "text-purple-400",
  json: "text-amber-400",
  yaml: "text-amber-400",
  md: "text-blue-300",
  py: "text-green-400",
  rs: "text-orange-500",
  go: "text-cyan-400",
  html: "text-orange-400",
}

const CHANGE_BAR_BLOCKS = 5

function ChangeBar({ add, del }: { add: number; del: number }) {
  const total = add + del
  if (total === 0) return null
  const addBlocks = Math.round((add / total) * CHANGE_BAR_BLOCKS)
  const delBlocks = CHANGE_BAR_BLOCKS - addBlocks
  return (
    <span className="flex items-center gap-[1px] shrink-0">
      {Array.from({ length: addBlocks }, (_, i) => (
        <span key={`a${i}`} className="inline-block w-[5px] h-[5px] rounded-[1px] bg-green-500/70" />
      ))}
      {Array.from({ length: delBlocks }, (_, i) => (
        <span key={`d${i}`} className="inline-block w-[5px] h-[5px] rounded-[1px] bg-red-400/70" />
      ))}
    </span>
  )
}

interface GroupedFileCardProps {
  file: GroupedFile
  isHighlighted?: boolean
  /** Called with diff data when the user clicks the card. Parent manages the modal. */
  onDiffLoaded?: (data: { head: string; working: string; filePath: string }) => void
}

export const GroupedFileCard = memo(function GroupedFileCard({ file, isHighlighted, onDiffLoaded }: GroupedFileCardProps) {
  const handleClick = useCallback(() => {
    onDiffLoaded?.({ head: file.netOriginal, working: file.netCurrent, filePath: file.filePath })
  }, [file.filePath, file.netOriginal, file.netCurrent, onDiffLoaded])

  const ext = file.filePath.split(".").pop()?.toLowerCase() ?? ""
  const extColor = EXT_COLORS[ext] ?? "text-muted-foreground"

  const turnLabel = file.turnRange[0] === file.turnRange[1]
    ? `T${file.turnRange[0] + 1}`
    : `T${file.turnRange[0] + 1}–T${file.turnRange[1] + 1}`

  return (
    <div
      data-file-path={file.filePath}
      className={cn(
        "rounded border elevation-2 depth-low transition-colors",
        isHighlighted
          ? "border-blue-500/40 ring-1 ring-blue-500/20"
          : "border-border",
      )}
    >
      <div className="flex items-center w-full bg-elevation-2 rounded hover:bg-elevation-3 transition-colors group">
        <button
          onClick={handleClick}
          className="flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1 cursor-pointer"
        >
          <span className={cn("text-[10px] font-mono font-bold shrink-0", extColor)}>
            {ext}
          </span>
          <GitStatusBadge status={file.gitStatus} />
          {file.subAgentId && <SubAgentIndicator agentId={file.subAgentId} />}
          <span className="text-[10px] text-muted-foreground font-mono truncate">
            {file.shortPath}
          </span>
          <span className="text-[10px] text-muted-foreground/50 shrink-0">
            {turnLabel}
          </span>
          {file.editCount > 1 && (
            <Badge
              variant="outline"
              className="text-[9px] px-1 py-0 h-3.5 font-mono shrink-0 border-border/50 text-muted-foreground/60"
            >
              {file.editCount}x
            </Badge>
          )}
        </button>
        <div className="flex items-center gap-1.5 pr-2 shrink-0">
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <Tooltip>
              <TooltipTrigger render={<button
                  onClick={(e) => { e.stopPropagation(); openInEditor(file.filePath, "file") }}
                  className="p-1 text-muted-foreground hover:text-blue-400 transition-colors"
                  aria-label="Open file in editor"
                />}>
                  <Code2 className="size-3" />
              </TooltipTrigger>
              <TooltipContent>Open in editor</TooltipContent>
            </Tooltip>
          </div>
          {file.addCount > 0 && (
            <span className="text-[10px] font-mono tabular-nums text-green-500/80">+{file.addCount}</span>
          )}
          {file.delCount > 0 && (
            <span className="text-[10px] font-mono tabular-nums text-red-400/80">-{file.delCount}</span>
          )}
          <ChangeBar add={file.addCount} del={file.delCount} />
        </div>
      </div>
    </div>
  )
})
