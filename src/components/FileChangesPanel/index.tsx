import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react"
import { FileCode2, Users, Minus, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import type { ParsedSession } from "@/lib/types"
import { cn } from "@/lib/utils"
import { GroupedFileCard } from "./GroupedFileCard"
import { DiffViewModal } from "../diff/DiffViewModal"
import { useFileChangesData, buildGroupedFilesByAgent, type AgentGroup } from "./useFileChangesData"
import { OPEN_SUBAGENT_EVENT } from "./file-change-indicators"
import { useDiffFontSize } from "@/contexts/DiffFontSizeContext"
import type { GroupedFile } from "./useFileChangesData"

/** Custom event name for cross-panel file focus. */
export const FOCUS_FILE_EVENT = "cogpit:focus-file"

/** Diff display mode: aggregated net diff or individual per-edit diffs. */
export type DiffMode = "net" | "per-edit"

const PREFS_KEY = "cogpit:file-changes-prefs"

function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return fallback
    const prefs = JSON.parse(raw)
    return key in prefs ? prefs[key] : fallback
  } catch { return fallback }
}

function savePref(key: string, value: unknown): void {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    const prefs = raw ? JSON.parse(raw) : {}
    prefs[key] = value
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch { /* ignore */ }
}

interface FileChangesPanelProps {
  session: ParsedSession
  sessionChangeKey: number
}

/** Diff modal state managed at panel level for keyboard navigation between files. */
interface DiffModalState {
  head: string
  working: string
  filePath: string
}

function AgentGroupSection({
  group,
  highlightPath,
  onDiffLoaded,
}: {
  group: AgentGroup
  highlightPath: string | null
  onDiffLoaded: (data: DiffModalState) => void
}) {
  const name = group.agentName || group.agentId.slice(0, 8)
  const type = group.subagentType

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 px-1.5 pt-1.5 pb-0.5">
        <span
          className="text-[10px] font-semibold text-indigo-400 truncate cursor-pointer hover:text-indigo-300 transition-colors"
          title={`Open subagent ${group.agentId}`}
          onClick={() => {
            window.dispatchEvent(new CustomEvent(OPEN_SUBAGENT_EVENT, { detail: { agentId: group.agentId } }))
          }}
        >
          {name}
        </span>
        {type && (
          <span className="text-[9px] text-muted-foreground/60 truncate">
            {type}
          </span>
        )}
        <Badge
          variant="outline"
          className="h-3.5 px-1 text-[9px] border-indigo-400/30 text-indigo-400/70"
        >
          {group.files.length}
        </Badge>
        <div className="flex-1" />
        <span className="text-[9px] font-mono tabular-nums text-green-500/60">
          +{group.totalAdd}
        </span>
        <span className="text-[9px] font-mono tabular-nums text-red-400/60">
          -{group.totalDel}
        </span>
      </div>
      {group.files.map((file) => (
        <GroupedFileCard
          key={file.filePath}
          file={file}
          isHighlighted={highlightPath === file.filePath}
          onDiffLoaded={onDiffLoaded}
        />
      ))}
    </div>
  )
}

export const FileChangesPanel = memo(function FileChangesPanel({ session, sessionChangeKey }: FileChangesPanelProps) {
  const { fontSize, increase: increaseFontSize, decrease: decreaseFontSize } = useDiffFontSize()
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const scrollOnNextChangeRef = useRef(false)
  const prevChangeCountRef = useRef(0)
  const prevTurnCountRef = useRef(session.turns.length)
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)

  // Highlighted file path (from TurnChangedFiles click)
  const [highlightPath, setHighlightPath] = useState<string | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [groupByAgent, setGroupByAgent] = useState(() => loadPref("groupByAgent", false))
  useEffect(() => { savePref("groupByAgent", groupByAgent) }, [groupByAgent])

  // Diff modal state — managed here so we can navigate between files
  const [diffModal, setDiffModal] = useState<DiffModalState | null>(null)

  const {
    fileChanges,
    fileContents,
    groupedByFile,
    agentMap,
  } = useFileChangesData(session)

  // Always show all changed files
  const activeGrouped = groupedByFile

  // Agent-grouped view
  const agentGroups = useMemo<AgentGroup[]>(() => {
    if (!groupByAgent) return []
    return buildGroupedFilesByAgent(fileChanges, "all", agentMap, fileContents)
  }, [groupByAgent, fileChanges, agentMap, fileContents])

  // Flat list of all files for keyboard navigation
  const allFiles = useMemo<GroupedFile[]>(() => {
    if (groupByAgent) {
      return agentGroups.flatMap((ag) => ag.files)
    }
    return activeGrouped
  }, [groupByAgent, agentGroups, activeGrouped])

  // Navigate to prev/next file in the diff modal
  const handleNavigate = useCallback((direction: "prev" | "next") => {
    if (!diffModal) return
    const currentIdx = allFiles.findIndex((f) => f.filePath === diffModal.filePath)
    if (currentIdx < 0) return
    const nextIdx = direction === "prev" ? currentIdx - 1 : currentIdx + 1
    if (nextIdx < 0 || nextIdx >= allFiles.length) return

    const nextFile = allFiles[nextIdx]
    setDiffModal({ head: nextFile.netOriginal, working: nextFile.netCurrent, filePath: nextFile.filePath })
  }, [diffModal, allFiles])

  const currentFileIdx = diffModal ? allFiles.findIndex((f) => f.filePath === diffModal.filePath) : -1

  // Listen for focus-file events from TurnChangedFiles
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filePath: string; turnIndex: number }>).detail
      if (!detail?.filePath) return

      // Highlight and scroll to the file
      setHighlightPath(detail.filePath)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = setTimeout(() => setHighlightPath(null), 3000)

      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector(
          `[data-file-path="${CSS.escape(detail.filePath)}"]`
        ) as HTMLElement | null
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" })
      })
    }

    window.addEventListener(FOCUS_FILE_EVENT, handler)
    return () => {
      window.removeEventListener(FOCUS_FILE_EVENT, handler)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    }
  }, [])

  const updateScrollIndicators = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollUp(el.scrollTop > 10)
    setCanScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 10)
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50
    updateScrollIndicators()
  }, [updateScrollIndicators])

  useEffect(() => {
    updateScrollIndicators()
  }, [fileChanges.length, activeGrouped.length, updateScrollIndicators])

  // Reset on session switch
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    isAtBottomRef.current = true
    scrollOnNextChangeRef.current = false
    prevChangeCountRef.current = fileChanges.length
    prevTurnCountRef.current = session.turns.length
    setHighlightPath(null)
    setDiffModal(null)
    updateScrollIndicators()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only runs on session switch
  }, [sessionChangeKey])

  // Detect new turns
  useEffect(() => {
    const turnCount = session.turns.length
    if (turnCount > prevTurnCountRef.current) {
      scrollOnNextChangeRef.current = true
    }
    prevTurnCountRef.current = turnCount
  }, [session.turns.length])

  // Auto-scroll on new changes
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

  let groupedAdd = 0
  let groupedDel = 0
  let totalFileCount = 0
  if (groupByAgent) {
    for (const ag of agentGroups) {
      groupedAdd += ag.totalAdd
      groupedDel += ag.totalDel
      totalFileCount += ag.files.length
    }
  } else {
    for (const g of activeGrouped) {
      groupedAdd += g.addCount
      groupedDel += g.delCount
    }
    totalFileCount = activeGrouped.length
  }

  return (
    <div className="flex flex-col h-full overflow-hidden border-border min-w-0 elevation-1">
      <div className="shrink-0 flex items-center gap-2 px-3 h-8 border-b border-border/50">
        <FileCode2 className="size-3.5 text-amber-400" />
        <span className="text-xs font-medium text-foreground">
          File Changes
        </span>
        <Badge
          variant="outline"
          className="h-4 px-1.5 text-[10px] border-border/70 text-muted-foreground"
        >
          {totalFileCount} file{totalFileCount !== 1 ? "s" : ""}
        </Badge>
        <div className="flex-1" />
        <span className="text-[10px] font-mono tabular-nums text-green-500/70">
          +{groupedAdd}
        </span>
        <span className="text-[10px] font-mono tabular-nums text-red-400/70">
          -{groupedDel}
        </span>

        {/* Group by agent toggle */}
        <Tooltip>
          <TooltipTrigger render={<button
              onClick={() => setGroupByAgent(!groupByAgent)}
              className={cn(
                "p-1 transition-colors rounded",
                groupByAgent
                  ? "text-indigo-400 bg-indigo-400/10"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-label={groupByAgent ? "Show all changes" : "Group by subagent"}
            />}>
              <Users className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>
            {groupByAgent
              ? "Show all changes"
              : "Group by subagent"}
          </TooltipContent>
        </Tooltip>

        {/* Font size controls */}
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger render={<button
                onClick={decreaseFontSize}
                className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Decrease diff font size"
              />}>
                <Minus className="size-3" />
            </TooltipTrigger>
            <TooltipContent>Decrease font size</TooltipContent>
          </Tooltip>
          <span className="text-[9px] font-mono tabular-nums text-muted-foreground/70 w-4 text-center select-none">
            {fontSize}
          </span>
          <Tooltip>
            <TooltipTrigger render={<button
                onClick={increaseFontSize}
                className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Increase diff font size"
              />}>
                <Plus className="size-3" />
            </TooltipTrigger>
            <TooltipContent>Increase font size</TooltipContent>
          </Tooltip>
        </div>

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
          <div className="p-1.5 space-y-1">
            {groupByAgent ? (
              agentGroups.length > 0 ? (
                agentGroups.map((ag) => (
                  <AgentGroupSection
                    key={ag.agentId}
                    group={ag}
                    highlightPath={highlightPath}
                    onDiffLoaded={setDiffModal}
                  />
                ))
              ) : (
                <div className="text-[11px] text-muted-foreground/50 text-center py-4">
                  No subagent changes in this session
                </div>
              )
            ) : activeGrouped.length > 0 ? (
              activeGrouped.map((file) => (
                <GroupedFileCard
                  key={file.filePath}
                  file={file}
                  isHighlighted={highlightPath === file.filePath}
                  onDiffLoaded={setDiffModal}
                />
              ))
            ) : (
              <div className="text-[11px] text-muted-foreground/50 text-center py-4">
                No file changes in this session
              </div>
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

      {/* Diff modal — rendered at panel level for file-to-file keyboard navigation */}
      {diffModal && (
        <DiffViewModal
          oldContent={diffModal.head}
          newContent={diffModal.working}
          filePath={diffModal.filePath}
          onClose={() => setDiffModal(null)}
          onPrev={() => handleNavigate("prev")}
          onNext={() => handleNavigate("next")}
          hasPrev={currentFileIdx > 0}
          hasNext={currentFileIdx >= 0 && currentFileIdx < allFiles.length - 1}
        />
      )}
    </div>
  )
})
