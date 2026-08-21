import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react"
import { FileCode2, ChevronsDownUp, ChevronsUpDown, Layers, Clock, X, Sigma, List, ChevronLeft, ChevronRight, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import type { ParsedSession } from "@/lib/types"
import { cn } from "@/lib/utils"
import { GroupedFileCard, type DiffMode } from "./GroupedFileCard"
import { useFileChangesData, buildGroupedFiles, buildGroupedFilesByAgent, type AgentGroup } from "./useFileChangesData"
import { OPEN_SUBAGENT_EVENT } from "./file-change-indicators"
import { useLocalStorage } from "@/hooks/useLocalStorage"

/** Custom event name for cross-panel file focus. */
export const FOCUS_FILE_EVENT = "cogpit:focus-file"

const PREFS_KEY = "cogpit:file-changes-prefs"

/** Shape of the persisted prefs bag. Numeric scope is transient and not stored. */
interface FileChangesPrefs {
  expanded: boolean
  diffMode: "net" | "per-edit"
  scope: "last" | "all"
  groupByAgent: boolean
}

const PREFS_DEFAULTS: FileChangesPrefs = {
  expanded: true,
  diffMode: "net",
  scope: "last",
  groupByAgent: false,
}

/** Scope: last turn, all turns, or a specific turn index. */
type Scope = "last" | "all" | number

export type { DiffMode } from "./GroupedFileCard"

interface FileChangesPanelProps {
  session: ParsedSession
  sessionChangeKey: number
}

function AgentGroupSection({
  group,
  allExpanded,
  highlightPath,
  diffMode,
}: {
  group: AgentGroup
  allExpanded: boolean
  highlightPath: string | null
  diffMode: DiffMode
}) {
  const name = group.agentName || group.agentId.slice(0, 8)
  const type = group.subagentType

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 px-1.5 pt-1.5 pb-0.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-auto min-w-0 truncate px-1 text-xs font-semibold"
          title={`Open subagent ${group.agentId}`}
          onClick={() => {
            window.dispatchEvent(new CustomEvent(OPEN_SUBAGENT_EVENT, { detail: { agentId: group.agentId } }))
          }}
        >
          {name}
        </Button>
        {type && (
          <span className="truncate text-xs text-muted-foreground">
            {type}
          </span>
        )}
        <Badge
          variant="outline"
          className="h-5 px-1.5 text-xs text-muted-foreground"
        >
          {group.files.length}
        </Badge>
        <div className="flex-1" />
        <span className="font-mono text-xs tabular-nums text-success">
          +{group.totalAdd}
        </span>
        <span className="font-mono text-xs tabular-nums text-destructive">
          -{group.totalDel}
        </span>
      </div>
      {group.files.map((file) => (
        <GroupedFileCard
          key={file.filePath}
          file={file}
          defaultOpen={allExpanded}
          isHighlighted={highlightPath === file.filePath}
          diffMode={diffMode}
        />
      ))}
    </div>
  )
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

  // Persisted prefs bag — stored as Partial to survive schema additions without data loss.
  // Merge with defaults at read time so missing keys never produce undefined.
  const [storedPrefs, setStoredPrefs] = useLocalStorage<Partial<FileChangesPrefs>>(PREFS_KEY, {})
  const prefs: FileChangesPrefs = { ...PREFS_DEFAULTS, ...storedPrefs }

  const allExpanded = prefs.expanded
  const diffMode = prefs.diffMode
  const groupByAgent = prefs.groupByAgent

  // Scope: "last" (default), "all", or a specific turn index (transient — not persisted)
  const [scope, setScope] = useState<Scope>(prefs.scope)

  const setAllExpanded = useCallback((value: boolean) => {
    setStoredPrefs((prev) => ({ ...prev, expanded: value }))
  }, [setStoredPrefs])

  const setDiffMode = useCallback((value: DiffMode) => {
    setStoredPrefs((prev) => ({ ...prev, diffMode: value }))
  }, [setStoredPrefs])

  const setGroupByAgent = useCallback((value: boolean) => {
    setStoredPrefs((prev) => ({ ...prev, groupByAgent: value }))
  }, [setStoredPrefs])

  // Only persist "last" or "all" scope — numeric scope is transient (from click events)
  useEffect(() => {
    if (typeof scope !== "number") {
      setStoredPrefs((prev) => ({ ...prev, scope }))
    }
  }, [scope, setStoredPrefs])

  // Highlighted file path (from TurnChangedFiles click)
  const [highlightPath, setHighlightPath] = useState<string | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const {
    fileChanges,
    fileContents,
    groupedByFile,
    groupedLastTurn,
    lastTurnIndex,
    agentMap,
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

  // Agent-grouped view
  const agentGroups = useMemo<AgentGroup[]>(() => {
    if (!groupByAgent) return []
    const effectiveScope = typeof scope === "number" ? scope : scope === "all" ? "all" : lastTurnIndex
    return buildGroupedFilesByAgent(fileChanges, effectiveScope, agentMap, fileContents)
  }, [groupByAgent, fileChanges, scope, lastTurnIndex, agentMap, fileContents])

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
    setScope(prefs.scope)
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
    <div className="view-transition-file-panel panel-enter-bottom flex h-full min-w-0 flex-col overflow-hidden bg-card">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <FileCode2 data-icon="inline-start" className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">
          File Changes
        </span>
        <Badge
          variant="outline"
          className="h-5 px-1.5 text-xs text-muted-foreground"
        >
          {totalFileCount} file{totalFileCount !== 1 ? "s" : ""}
        </Badge>
        <div className="flex-1" />
        <span className="font-mono text-xs tabular-nums text-success">
          +{groupedAdd}
        </span>
        <span className="font-mono text-xs tabular-nums text-destructive">
          -{groupedDel}
        </span>

        <Tooltip>
          <TooltipTrigger render={<Button
              variant={groupByAgent ? "secondary" : "ghost"}
              size="icon-xs"
              onClick={() => setGroupByAgent(!groupByAgent)}
              aria-label={groupByAgent ? "Show all changes" : "Group by subagent"}
            />}>
              <Users data-icon="inline-start" />
          </TooltipTrigger>
          <TooltipContent>
            {groupByAgent
              ? "Show all changes"
              : "Group by subagent"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger render={<Button
              variant={scope === "all" ? "secondary" : "ghost"}
              size="icon-xs"
              onClick={handleScopeToggle}
              aria-label={scope === "last" ? "Show all turns" : "Show last turn only"}
            />}>
              {scope === "all" ? <Layers data-icon="inline-start" /> : <Clock data-icon="inline-start" />}
          </TooltipTrigger>
          <TooltipContent>
            {scope === "last"
              ? "Click for all turns"
              : "Click for last turn only"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger render={<Button
              variant={diffMode === "per-edit" ? "secondary" : "ghost"}
              size="icon-xs"
              onClick={() => setDiffMode(diffMode === "net" ? "per-edit" : "net")}
              aria-label={diffMode === "net" ? "Show per-edit diffs" : "Show net diff"}
            />}>
              {diffMode === "net" ? <Sigma data-icon="inline-start" /> : <List data-icon="inline-start" />}
          </TooltipTrigger>
          <TooltipContent>
            {diffMode === "net"
              ? "Switch to per-edit diffs"
              : "Switch to net diff"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger render={<Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setAllExpanded(!allExpanded)}
              aria-label={allExpanded ? "Collapse all" : "Expand all"}
            />}>
              {allExpanded ? <ChevronsDownUp data-icon="inline-start" /> : <ChevronsUpDown data-icon="inline-start" />}
          </TooltipTrigger>
          <TooltipContent>{allExpanded ? "Collapse all" : "Expand all"}</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b bg-muted/30 px-3 py-1">
        <span className="text-xs text-muted-foreground">
          Showing:
        </span>
        {scope !== "all" && lastTurnIndex > 0 && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              const current = typeof scope === "number" ? scope : lastTurnIndex
              if (current > 0) setScope(current - 1)
            }}
            disabled={(typeof scope === "number" ? scope : lastTurnIndex) <= 0}
            aria-label="Previous turn"
          >
            <ChevronLeft data-icon="inline-start" />
          </Button>
        )}
        <span className={cn(
          "text-xs font-medium",
          typeof scope === "number" ? "text-foreground" : "text-muted-foreground",
        )}>
          {scopeLabel}
        </span>
        {scope !== "all" && lastTurnIndex > 0 && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              setScope((currentScope) => {
                if (typeof currentScope !== "number") return currentScope
                return currentScope + 1 >= lastTurnIndex ? "last" : currentScope + 1
              })
            }}
            disabled={scope === "last"}
            aria-label="Next turn"
          >
            <ChevronRight data-icon="inline-start" />
          </Button>
        )}
        {typeof scope === "number" && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setScope("last")}
            aria-label="Back to last turn"
          >
            <X data-icon="inline-start" />
          </Button>
        )}
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent transition-opacity duration-200",
            canScrollUp ? "opacity-100" : "opacity-0"
          )}
        />
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto"
        >
          <div className="flex flex-col gap-1 p-1.5">
            {groupByAgent ? (
              agentGroups.length > 0 ? (
                agentGroups.map((ag) => (
                  <AgentGroupSection
                    key={ag.agentId}
                    group={ag}
                    allExpanded={allExpanded}
                    highlightPath={highlightPath}
                    diffMode={diffMode}
                  />
                ))
              ) : (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  No subagent changes in {scopeLabel.toLowerCase()}
                </div>
              )
            ) : activeGrouped.length > 0 ? (
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
              <div className="py-4 text-center text-xs text-muted-foreground">
                No file changes in {scopeLabel.toLowerCase()}
              </div>
            )}
          </div>
          <div ref={bottomRef} />
        </div>
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-background to-transparent transition-opacity duration-200",
            canScrollDown ? "opacity-100" : "opacity-0"
          )}
        />
      </div>
    </div>
  )
})
