import { useState, useRef, useCallback, useEffect, memo } from "react"
import { FileCode2, ChevronsDownUp, ChevronsUpDown } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import type { ParsedSession } from "@/lib/types"
import { cn } from "@/lib/utils"
import { FileChangeCard, DeletedFileCard } from "./FileChangeCard"
import { useFileChangesData } from "./useFileChangesData"

// Re-export sub-components and hooks for external consumers
export { FileChangeCard, DeletedFileCard } from "./FileChangeCard"
export { useFileChangesData } from "./useFileChangesData"
export type { FileChange, RenderItem } from "./useFileChangesData"
export { diffLineCount } from "@/lib/diffUtils"

interface FileChangesPanelProps {
  session: ParsedSession
  sessionChangeKey: number
}

export const FileChangesPanel = memo(function FileChangesPanel({ session, sessionChangeKey }: FileChangesPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const scrollOnNextChangeRef = useRef(false)
  const prevChangeCountRef = useRef(0)
  const prevTurnCountRef = useRef(session.turns.length)
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)
  const [allExpanded, setAllExpanded] = useState(true)

  const { fileChanges, renderItems, totalAdditions, totalDeletions } = useFileChangesData(session)

  const updateScrollIndicators = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollUp(el.scrollTop > 10)
    setCanScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 10)
  }, [])

  // Track whether user is scrolled to the bottom + update indicators
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50
    updateScrollIndicators()
  }, [updateScrollIndicators])

  // Update indicators when content changes
  useEffect(() => {
    updateScrollIndicators()
  }, [fileChanges.length, updateScrollIndicators])

  // Reset scroll position instantly when switching sessions
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    isAtBottomRef.current = true
    scrollOnNextChangeRef.current = false
    prevChangeCountRef.current = fileChanges.length
    prevTurnCountRef.current = session.turns.length
    updateScrollIndicators()
  }, [sessionChangeKey])

  // Detect new turns (user sent a new prompt)
  useEffect(() => {
    const turnCount = session.turns.length
    if (turnCount > prevTurnCountRef.current) {
      scrollOnNextChangeRef.current = true
    }
    prevTurnCountRef.current = turnCount
  }, [session.turns.length])

  // Auto-scroll when new file changes arrive
  useEffect(() => {
    if (fileChanges.length <= prevChangeCountRef.current) {
      prevChangeCountRef.current = fileChanges.length
      return
    }
    prevChangeCountRef.current = fileChanges.length

    if (scrollOnNextChangeRef.current || isAtBottomRef.current) {
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" })
      })
      scrollOnNextChangeRef.current = false
    }
  }, [fileChanges.length])

  if (fileChanges.length === 0) return null

  return (
    <div className="flex flex-col h-full overflow-hidden border-border min-w-0 elevation-1">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
        <FileCode2 className="size-3.5 text-amber-400" />
        <span className="text-xs font-medium text-foreground">
          File Changes
        </span>
        <Badge
          variant="outline"
          className="h-4 px-1.5 text-[10px] border-border/70 text-muted-foreground"
        >
          {fileChanges.length}
        </Badge>
        <div className="flex-1" />
        <span className="text-[10px] font-mono tabular-nums text-green-500/70">
          +{totalAdditions}
        </span>
        <span className="text-[10px] font-mono tabular-nums text-red-400/70">
          -{totalDeletions}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setAllExpanded(!allExpanded)}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors"
              aria-label={allExpanded ? "Collapse all" : "Expand all"}
            >
              {allExpanded ? <ChevronsDownUp className="size-3.5" /> : <ChevronsUpDown className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{allExpanded ? "Collapse all" : "Expand all"}</TooltipContent>
        </Tooltip>
      </div>
      <div className="relative flex-1 min-h-0">
        {/* Top fade */}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-elevation-0 to-transparent transition-opacity duration-200",
            canScrollUp ? "opacity-100" : "opacity-0"
          )}
        />
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto"
        >
          <div className="p-3 space-y-3">
            {renderItems.map((item) =>
              item.type === "change" ? (
                <FileChangeCard
                  key={item.key}
                  turnIndex={item.turnIndex}
                  toolCall={item.toolCall}
                  agentId={item.agentId}
                  defaultOpen={allExpanded}
                />
              ) : (
                <DeletedFileCard
                  key={item.key}
                  filePath={item.filePath}
                  lineCount={item.lines}
                  turnIndex={item.turnIndex}
                />
              )
            )}
          </div>
          <div ref={bottomRef} />
        </div>
        {/* Bottom fade */}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-elevation-0 to-transparent transition-opacity duration-200",
            canScrollDown ? "opacity-100" : "opacity-0"
          )}
        />
      </div>
    </div>
  )
})
