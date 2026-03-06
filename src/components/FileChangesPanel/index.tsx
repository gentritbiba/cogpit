import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react"
import { FileCode2, ChevronsDownUp, ChevronsUpDown, Layers, Clock, X, Sigma, List } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import type { ParsedSession } from "@/lib/types"
import { cn } from "@/lib/utils"
import { GroupedFileCard } from "./GroupedFileCard"
import { useFileChangesData, buildGroupedFiles } from "./useFileChangesData"

/** Custom event name for cross-panel file focus. */
export const FOCUS_FILE_EVENT = "cogpit:focus-file"

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

/** Scope: last turn, all turns, or a specific turn index. */
type Scope = "last" | "all" | number

/** Diff display mode: aggregated net diff or individual per-edit diffs. */
export type DiffMode = "net" | "per-edit"

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
  const [allExpanded, setAllExpanded] = useState(() => loadPref("expanded", true))
  const [diffMode, setDiffMode] = useState<DiffMode>(() => loadPref("diffMode", "net"))

  // Scope: "last" (default), "all", or a specific turn index
  const [scope, setScope] = useState<Scope>(() => loadPref("scope", "last") as Scope)

  // Persist toggle preferences
  useEffect(() => { savePref("expanded", allExpanded) }, [allExpanded])
  useEffect(() => { savePref("diffMode", diffMode) }, [diffMode])
  useEffect(() => {
    // Only persist "last" or "all" — numeric scope is transient (from click events)
    if (typeof scope !== "number") savePref("scope", scope)
  }, [scope])

  // Highlighted file path (from TurnChangedFiles click)
  const [highlightPath, setHighlightPath] = useState<string | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const {
    fileChanges,
    fileContents,
    groupedByFile,
    groupedLastTurn,
    lastTurnIndex,
  } = useFileChangesData(session)

  // Compute grouped files for specific turn on demand
  const groupedForTurn = useMemo(() => {
    if (typeof scope !== "number") return null
    return buildGroupedFiles(fileChanges, scope, fileContents)
  }, [fileChanges, scope, fileContents])

  function getActiveGrouped(): typeof groupedByFile {
    if (typeof scope === "number") return groupedForTurn ?? []
    if (scope === "all") return groupedByFile
    return groupedLastTurn
  }
  const activeGrouped = getActiveGrouped()

  // Scroll to file cards via DOM query (avoids per-file closure allocation)

  // Listen for focus-file events from TurnChangedFiles
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filePath: string; turnIndex: number }>).detail
      if (!detail?.filePath) return

      // Switch to that specific turn's scope
      setScope(detail.turnIndex)

      // Highlight and scroll to the file
      setHighlightPath(detail.filePath)
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      highlightTimerRef.current = setTimeout(() => setHighlightPath(null), 3000)

      // Scroll after a tick (to let scope change render)
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

  // Reset scroll position on session switch
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    isAtBottomRef.current = true
    scrollOnNextChangeRef.current = false
    prevChangeCountRef.current = fileChanges.length
    prevTurnCountRef.current = session.turns.length
    setScope(loadPref("scope", "last") as Scope)
    setHighlightPath(null)
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
  for (const g of activeGrouped) {
    groupedAdd += g.addCount
    groupedDel += g.delCount
  }

  function handleScopeToggle(): void {
    setScope(scope === "last" ? "all" : "last")
  }

  function getScopeLabel(): string {
    if (typeof scope === "number") return `Turn ${scope + 1}`
    if (scope === "all") return "All turns"
    return `Last turn (T${lastTurnIndex + 1})`
  }
  const scopeLabel = getScopeLabel()

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
          {activeGrouped.length} file{activeGrouped.length !== 1 ? "s" : ""}
        </Badge>
        <div className="flex-1" />
        <span className="text-[10px] font-mono tabular-nums text-green-500/70">
          +{groupedAdd}
        </span>
        <span className="text-[10px] font-mono tabular-nums text-red-400/70">
          -{groupedDel}
        </span>

        {/* Scope toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleScopeToggle}
              className={cn(
                "p-1 transition-colors rounded",
                scope === "all"
                  ? "text-amber-400 bg-amber-400/10"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-label={scope === "last" ? "Show all turns" : "Show last turn only"}
            >
              {scope === "all" ? <Layers className="size-3.5" /> : <Clock className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {scope === "last"
              ? "Click for all turns"
              : "Click for last turn only"}
          </TooltipContent>
        </Tooltip>

        {/* Diff mode toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setDiffMode(diffMode === "net" ? "per-edit" : "net")}
              className={cn(
                "p-1 transition-colors rounded",
                diffMode === "per-edit"
                  ? "text-violet-400 bg-violet-400/10"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-label={diffMode === "net" ? "Show per-edit diffs" : "Show net diff"}
            >
              {diffMode === "net" ? <Sigma className="size-3.5" /> : <List className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {diffMode === "net"
              ? "Switch to per-edit diffs"
              : "Switch to net diff"}
          </TooltipContent>
        </Tooltip>

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

      {/* Scope indicator bar */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1 border-b border-border/50 bg-elevation-1/50">
        <span className="text-[10px] text-muted-foreground/70">
          Showing:
        </span>
        <span className={cn(
          "text-[10px] font-medium",
          typeof scope === "number" ? "text-blue-400" : "text-muted-foreground",
        )}>
          {scopeLabel}
        </span>
        {typeof scope === "number" && (
          <button
            onClick={() => setScope("last")}
            className="p-0.5 text-muted-foreground/50 hover:text-foreground transition-colors"
            title="Back to last turn"
          >
            <X className="size-3" />
          </button>
        )}
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
            {activeGrouped.length > 0 ? (
              activeGrouped.map((file) => (
                <GroupedFileCard
                  key={file.filePath}
                  file={file}
                  defaultOpen={allExpanded}
                  isHighlighted={highlightPath === file.filePath}
                  diffMode={diffMode}
                />
              ))
            ) : (
              <div className="text-[11px] text-muted-foreground/50 text-center py-4">
                No file changes in {scopeLabel.toLowerCase()}
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
    </div>
  )
})
