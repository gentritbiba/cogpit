import { useMemo, useState, useRef, useCallback, useEffect } from "react"
import { FileCode2, CheckCircle, XCircle, ChevronDown, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { EditDiffView } from "./timeline/EditDiffView"
import { getToolBadgeStyle } from "./timeline/ToolCallCard"
import type { ParsedSession, ToolCall } from "@/lib/types"
import { cn } from "@/lib/utils"

interface FileChange {
  turnIndex: number
  toolCall: ToolCall
}

interface FileChangesPanelProps {
  session: ParsedSession
  sessionChangeKey: number
}

function FileChangeCard({ turnIndex, toolCall }: FileChange) {
  const [open, setOpen] = useState(true)

  const filePath = String(toolCall.input.file_path ?? toolCall.input.path ?? "")
  const shortPath = filePath.split("/").slice(-3).join("/")
  const isEdit = toolCall.name === "Edit"
  const oldString = isEdit ? String(toolCall.input.old_string ?? "") : ""
  const newString = isEdit
    ? String(toolCall.input.new_string ?? "")
    : String(toolCall.input.content ?? "")

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/30 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 hover:bg-zinc-800/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="size-3 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="size-3 text-zinc-500 shrink-0" />
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
        <span className="text-[10px] text-zinc-400 font-mono truncate">
          {shortPath}
        </span>
        <span className="text-[10px] text-zinc-600 shrink-0">
          T{turnIndex + 1}
        </span>
        <div className="flex-1" />
        {toolCall.isError ? (
          <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
        ) : toolCall.result !== null ? (
          <CheckCircle className="w-3.5 h-3.5 text-green-500/60 shrink-0" />
        ) : null}
      </button>
      {open && (
        <EditDiffView
          oldString={oldString}
          newString={newString}
          filePath={filePath}
          compact={false}
        />
      )}
    </div>
  )
}

export function FileChangesPanel({ session, sessionChangeKey }: FileChangesPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const scrollOnNextChangeRef = useRef(false)
  const prevChangeCountRef = useRef(0)
  const prevTurnCountRef = useRef(session.turns.length)
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)

  const fileChanges = useMemo(() => {
    const changes: FileChange[] = []
    session.turns.forEach((turn, turnIndex) => {
      turn.toolCalls.forEach((tc) => {
        if (tc.name === "Edit" || tc.name === "Write") {
          changes.push({ turnIndex, toolCall: tc })
        }
      })
    })
    return changes
  }, [session])

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
    <div className="flex flex-col h-full overflow-hidden border-zinc-800 min-w-0">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/50">
        <FileCode2 className="size-3.5 text-amber-400" />
        <span className="text-xs font-medium text-zinc-300">
          File Changes
        </span>
        <Badge
          variant="outline"
          className="h-4 px-1.5 text-[10px] border-zinc-700 text-zinc-500"
        >
          {fileChanges.length}
        </Badge>
      </div>
      <div className="relative flex-1 min-h-0">
        {/* Top fade */}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-zinc-950 to-transparent transition-opacity duration-200",
            canScrollUp ? "opacity-100" : "opacity-0"
          )}
        />
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto"
        >
          <div className="p-3 space-y-3">
            {fileChanges.map(({ turnIndex, toolCall }) => (
              <FileChangeCard
                key={toolCall.id}
                turnIndex={turnIndex}
                toolCall={toolCall}
              />
            ))}
          </div>
          <div ref={bottomRef} />
        </div>
        {/* Bottom fade */}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-zinc-950 to-transparent transition-opacity duration-200",
            canScrollDown ? "opacity-100" : "opacity-0"
          )}
        />
      </div>
    </div>
  )
}
