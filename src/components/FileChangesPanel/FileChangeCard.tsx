import { useState, useRef, useEffect, useLayoutEffect } from "react"
import { useNearViewport } from "@/hooks/useNearViewport"
import { ChevronDown, ChevronRight, Trash2, CheckCircle, XCircle, Code2, GitCompareArrows } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { EditDiffView } from "../timeline/EditDiffView"
import { getToolBadgeStyle } from "../timeline/ToolCallCard"
import type { ToolCall } from "@/lib/types"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"

function openInEditor(filePath: string, mode: "file" | "diff") {
  authFetch("/api/open-in-editor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, mode }),
  })
}

interface FileChangeCardProps {
  turnIndex: number
  toolCall: ToolCall
  agentId?: string
  defaultOpen: boolean
}

export function FileChangeCard({ turnIndex, toolCall, agentId, defaultOpen }: FileChangeCardProps) {
  const { ref, isNear } = useNearViewport()
  const [open, setOpen] = useState(defaultOpen)
  const prevDefaultRef = useRef(defaultOpen)
  useEffect(() => {
    if (prevDefaultRef.current !== defaultOpen) {
      prevDefaultRef.current = defaultOpen
      setOpen(defaultOpen)
    }
  }, [defaultOpen])

  const filePath = String(toolCall.input.file_path ?? toolCall.input.path ?? "")
  const shortPath = filePath.split("/").slice(-3).join("/")
  const isEdit = toolCall.name === "Edit"
  const oldString = isEdit ? String(toolCall.input.old_string ?? "") : ""
  const newString = isEdit
    ? String(toolCall.input.new_string ?? "")
    : String(toolCall.input.content ?? "")

  // Only mount the expensive EditDiffView (LCS + Shiki) when near viewport.
  // When the diff unmounts, preserve its last measured height as a placeholder
  // so the scroll container's total height stays stable (prevents scroll jumping).
  const showDiff = open && isNear
  const diffRef = useRef<HTMLDivElement>(null)
  const lastDiffHeightRef = useRef(0)

  useLayoutEffect(() => {
    if (showDiff && diffRef.current) {
      lastDiffHeightRef.current = diffRef.current.offsetHeight
    }
  }, [showDiff])

  return (
    <div ref={ref} data-file-change className="rounded-md border border-border elevation-2 depth-low">
      <div className="sticky top-0 z-10 flex items-center w-full bg-elevation-2 rounded-t-md hover:bg-elevation-3 transition-colors group">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 flex-1 min-w-0 px-2.5 py-1.5"
        >
          {open ? (
            <ChevronDown className="size-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="size-3 text-muted-foreground shrink-0" />
          )}
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] px-1.5 py-0 h-4 font-mono shrink-0",
              getToolBadgeStyle(toolCall.name)
            )}
          >
            {toolCall.name}
          </Badge>
          <span className="text-[10px] text-muted-foreground font-mono truncate">
            {shortPath}
          </span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            T{turnIndex + 1}
          </span>
          {agentId && (
            <Badge
              variant="outline"
              className="text-[9px] px-1 py-0 h-3.5 font-mono shrink-0 border-indigo-800/60 text-indigo-400"
            >
              Sub-agent
            </Badge>
          )}
        </button>
        <div className="flex items-center gap-0.5 pr-1.5 shrink-0">
          {filePath && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => openInEditor(filePath, "file")}
                    className="p-1 text-muted-foreground hover:text-blue-400 transition-colors opacity-0 group-hover:opacity-100"
                    aria-label="Open file in editor"
                  >
                    <Code2 className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Open file in editor</TooltipContent>
              </Tooltip>
              {isEdit && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => openInEditor(filePath, "diff")}
                      className="p-1 text-muted-foreground hover:text-amber-400 transition-colors opacity-0 group-hover:opacity-100"
                      aria-label="View git changes in editor"
                    >
                      <GitCompareArrows className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>View git changes in editor</TooltipContent>
                </Tooltip>
              )}
            </>
          )}
          {toolCall.isError ? (
            <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
          ) : toolCall.result !== null ? (
            <CheckCircle className="w-3.5 h-3.5 text-green-500/60 shrink-0" />
          ) : null}
        </div>
      </div>
      {showDiff ? (
        <div ref={diffRef} className="overflow-hidden rounded-b-md">
          <EditDiffView
            oldString={oldString}
            newString={newString}
            filePath={filePath}
            compact={false}
          />
        </div>
      ) : open && lastDiffHeightRef.current > 0 ? (
        <div style={{ height: lastDiffHeightRef.current }} />
      ) : null}
    </div>
  )
}

export function DeletedFileCard({ filePath, lineCount, turnIndex }: { filePath: string; lineCount: number; turnIndex: number }) {
  const shortPath = filePath.split("/").slice(-3).join("/")
  return (
    <div className="rounded-md border border-red-900/40 bg-red-950/20 overflow-hidden depth-low">
      <div className="flex items-center gap-2 w-full px-2.5 py-1.5">
        <Trash2 className="size-3 text-red-400/70 shrink-0" />
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 h-4 font-mono shrink-0 border-red-800/60 text-red-400"
        >
          Deleted
        </Badge>
        <span className="text-[10px] text-muted-foreground font-mono truncate">
          {shortPath}
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0">
          T{turnIndex + 1}
        </span>
        <div className="flex-1" />
        {lineCount > 0 && (
          <span className="text-[10px] font-mono tabular-nums text-red-400/70 shrink-0">
            -{lineCount}
          </span>
        )}
      </div>
    </div>
  )
}
