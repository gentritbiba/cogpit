import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Clock, ChevronRight, ChevronDown, RotateCcw, Redo2, Minimize2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { UserMessage } from "./timeline/UserMessage"
import { ThinkingBlock } from "./timeline/ThinkingBlock"
import { AssistantText } from "./timeline/AssistantText"
import { ToolCallCard, getToolBadgeStyle } from "./timeline/ToolCallCard"
import { SubAgentPanel } from "./timeline/SubAgentPanel"
import { BackgroundAgentPanel } from "./timeline/BackgroundAgentPanel"
import { TurnContextMenu } from "@/components/TurnContextMenu"
import { BranchIndicator } from "@/components/BranchIndicator"
import { UndoRedoBar } from "@/components/UndoRedoBar"
import type { ParsedSession, Turn, TurnContentBlock, ToolCall, Branch } from "@/lib/types"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format"

// ── Style constants ──────────────────────────────────────────────────────────

const CARD_STYLES = {
  user:        "bg-blue-500/[0.06] border border-blue-500/10",
  userAgent:   "bg-green-500/[0.06] border border-green-500/10",
  assistant:   "bg-green-500/[0.06] border border-green-500/10",
  subAgent:    "bg-indigo-500/[0.06] border border-indigo-500/10",
  thinking:    "bg-violet-500/[0.06] border border-violet-500/10",
  orphanTools: "bg-muted-foreground/[0.06] border border-border/30",
} as const

const BORDER_STYLES = {
  assistant: "border-green-500/10",
  subAgent:  "border-indigo-500/10",
} as const

// ── Helpers ──────────────────────────────────────────────────────────────────

function matchesSearch(turn: Turn, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()

  if (turn.userMessage) {
    const text =
      typeof turn.userMessage === "string"
        ? turn.userMessage
        : JSON.stringify(turn.userMessage)
    if (text.toLowerCase().includes(q)) return true
  }

  for (const t of turn.assistantText) {
    if (t.toLowerCase().includes(q)) return true
  }

  for (const tb of turn.thinking) {
    if (tb.thinking.toLowerCase().includes(q)) return true
  }

  for (const tc of turn.toolCalls) {
    if (tc.name.toLowerCase().includes(q)) return true
    if (JSON.stringify(tc.input).toLowerCase().includes(q)) return true
    if (tc.result?.toLowerCase().includes(q)) return true
  }

  return false
}

/** Collect consecutive tool_calls blocks starting at `startIndex`. */
function collectToolCalls(blocks: TurnContentBlock[], startIndex: number): { toolCalls: ToolCall[]; nextIndex: number } {
  const toolCalls: ToolCall[] = []
  let j = startIndex
  while (j < blocks.length && blocks[j].kind === "tool_calls") {
    toolCalls.push(...(blocks[j] as { kind: "tool_calls"; toolCalls: ToolCall[] }).toolCalls)
    j++
  }
  return { toolCalls, nextIndex: j }
}

function toolCallCountLabel(count: number): string {
  return `${count} tool call${count !== 1 ? "s" : ""}`
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ConversationTimelineProps {
  session: ParsedSession
  activeTurnIndex: number | null
  activeToolCallId: string | null
  searchQuery: string
  expandAll: boolean
  isAgentActive?: boolean
  isSubAgentView?: boolean
  scrollContainerRef?: React.RefObject<HTMLElement | null>
  branchesAtTurn?: (turnIndex: number) => Branch[]
  onRestoreToHere?: (turnIndex: number) => void
  onOpenBranches?: (turnIndex: number) => void
  onBranchFromHere?: (turnIndex: number) => void
  canRedo?: boolean
  redoTurnCount?: number
  redoGhostTurns?: Turn[]
  onRedoAll?: () => void
  onRedoUpTo?: (ghostTurnIndex: number) => void
  onEditCommand?: (commandName: string) => void
}

interface TimelineInnerProps {
  filteredTurns: { turn: Turn; index: number }[]
  activeTurnIndex: number | null
  activeToolCallId: string | null
  expandAll: boolean
  isAgentActive: boolean
  isSubAgentView: boolean
  hasUndoCallbacks: boolean
  branchesAtTurn?: (turnIndex: number) => Branch[]
  onRestoreToHere?: (turnIndex: number) => void
  onOpenBranches?: (turnIndex: number) => void
  onBranchFromHere?: (turnIndex: number) => void
  canRedo: boolean
  redoTurnCount: number
  redoGhostTurns: Turn[]
  onRedoAll?: () => void
  onRedoUpTo?: (ghostTurnIndex: number) => void
  sessionTurnCount: number
  onEditCommand?: (commandName: string) => void
}

// Threshold: only virtualize when we have enough turns to benefit
const VIRTUALIZE_THRESHOLD = 30

// ── Main component ───────────────────────────────────────────────────────────

export const ConversationTimeline = memo(function ConversationTimeline({
  session,
  activeTurnIndex,
  activeToolCallId,
  searchQuery,
  expandAll,
  isAgentActive = false,
  isSubAgentView = false,
  scrollContainerRef,
  branchesAtTurn,
  onRestoreToHere,
  onOpenBranches,
  onBranchFromHere,
  canRedo = false,
  redoTurnCount = 0,
  redoGhostTurns = [],
  onRedoAll,
  onRedoUpTo,
  onEditCommand,
}: ConversationTimelineProps) {
  const hasUndoCallbacks = onRestoreToHere !== undefined

  const allTurns = useMemo(
    () => session.turns.map((turn, index) => ({ turn, index })),
    [session.turns]
  )
  const filteredTurns = useMemo(
    () => searchQuery
      ? allTurns.filter(({ turn }) => matchesSearch(turn, searchQuery))
      : allTurns,
    [allTurns, searchQuery]
  )

  const shouldVirtualize = filteredTurns.length >= VIRTUALIZE_THRESHOLD && scrollContainerRef?.current != null

  if (filteredTurns.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        {searchQuery ? "No turns match your search." : "No turns in this session."}
      </div>
    )
  }

  const sharedProps: TimelineInnerProps = {
    filteredTurns,
    activeTurnIndex,
    activeToolCallId,
    expandAll,
    isAgentActive,
    isSubAgentView,
    hasUndoCallbacks,
    branchesAtTurn,
    onRestoreToHere,
    onOpenBranches,
    onBranchFromHere,
    canRedo,
    redoTurnCount,
    redoGhostTurns,
    onRedoAll,
    onRedoUpTo,
    sessionTurnCount: session.turns.length,
    onEditCommand,
  }

  if (shouldVirtualize) {
    return <VirtualizedTimeline {...sharedProps} scrollContainerRef={scrollContainerRef} />
  }

  return <NonVirtualTimeline {...sharedProps} />
})

// ── Non-virtualized timeline ─────────────────────────────────────────────────

function NonVirtualTimeline(props: TimelineInnerProps) {
  const {
    filteredTurns,
    activeTurnIndex,
    canRedo,
    redoTurnCount,
    redoGhostTurns,
    onRedoAll,
    onRedoUpTo,
    sessionTurnCount,
  } = props

  const turnRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const setTurnRef = useCallback(
    (index: number) => (el: HTMLDivElement | null) => {
      if (el) {
        turnRefs.current.set(index, el)
      } else {
        turnRefs.current.delete(index)
      }
    },
    []
  )

  useEffect(() => {
    if (activeTurnIndex === null) return
    const el = turnRefs.current.get(activeTurnIndex)
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }, [activeTurnIndex])

  return (
    <div className="space-y-3">
      {filteredTurns.map(({ turn, index }) => (
        <MaybeContextMenuTurn key={turn.id} turn={turn} index={index} props={props}>
          <div ref={setTurnRef(index)} data-turn-index={index}>
            {turn.compactionSummary && (
              <CompactionMarker summary={turn.compactionSummary} />
            )}
            <TurnSection
              turn={turn}
              index={index}
              isActive={activeTurnIndex === index}
              activeToolCallId={props.activeToolCallId}
              expandAll={props.expandAll}
              isAgentActive={props.isAgentActive && index === sessionTurnCount - 1}
              isSubAgentView={props.isSubAgentView}
              branchCount={props.branchesAtTurn ? props.branchesAtTurn(index).length : 0}
              onRestoreToHere={props.onRestoreToHere}
              onOpenBranches={props.onOpenBranches}
              onEditCommand={props.onEditCommand}
            />
          </div>
        </MaybeContextMenuTurn>
      ))}
      <RedoSection
        canRedo={canRedo}
        redoTurnCount={redoTurnCount}
        redoGhostTurns={redoGhostTurns}
        onRedoAll={onRedoAll}
        onRedoUpTo={onRedoUpTo}
        sessionTurnCount={sessionTurnCount}
      />
    </div>
  )
}

// ── Virtualized timeline ─────────────────────────────────────────────────────

function VirtualizedTimeline(
  props: TimelineInnerProps & { scrollContainerRef: React.RefObject<HTMLElement | null> }
) {
  const {
    filteredTurns,
    scrollContainerRef,
    activeTurnIndex,
    canRedo,
    redoTurnCount,
    redoGhostTurns,
    onRedoAll,
    onRedoUpTo,
    sessionTurnCount,
  } = props

  const virtualizer = useVirtualizer({
    count: filteredTurns.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 200,
    overscan: 5,
  })

  const turnIndexToVirtualIdx = useMemo(() => {
    const map = new Map<number, number>()
    for (let i = 0; i < filteredTurns.length; i++) {
      map.set(filteredTurns[i].index, i)
    }
    return map
  }, [filteredTurns])

  const lastScrolledTurnRef = useRef<number | null>(null)
  useEffect(() => {
    if (activeTurnIndex === null) {
      lastScrolledTurnRef.current = null
      return
    }
    if (activeTurnIndex === lastScrolledTurnRef.current) return
    lastScrolledTurnRef.current = activeTurnIndex
    const virtualIdx = turnIndexToVirtualIdx.get(activeTurnIndex)
    if (virtualIdx !== undefined) {
      virtualizer.scrollToIndex(virtualIdx, { align: "start", behavior: "smooth" })
    }
  }, [activeTurnIndex, turnIndexToVirtualIdx, virtualizer])

  return (
    <div
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: "100%",
        position: "relative",
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const { turn, index } = filteredTurns[virtualRow.index]
        const isLastVirtualRow = virtualRow.index === filteredTurns.length - 1

        return (
          <MaybeContextMenuTurn key={turn.id} turn={turn} index={index} props={props}>
            <div
              data-index={virtualRow.index}
              data-turn-index={index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {turn.compactionSummary && (
                <CompactionMarker summary={turn.compactionSummary} />
              )}
              <TurnSection
                turn={turn}
                index={index}
                isActive={activeTurnIndex === index}
                activeToolCallId={props.activeToolCallId}
                expandAll={props.expandAll}
                isAgentActive={props.isAgentActive && index === sessionTurnCount - 1}
                isSubAgentView={props.isSubAgentView}
                branchCount={props.branchesAtTurn ? props.branchesAtTurn(index).length : 0}
                onRestoreToHere={props.onRestoreToHere}
                onOpenBranches={props.onOpenBranches}
                onEditCommand={props.onEditCommand}
              />
              {!isLastVirtualRow && <Separator className="bg-border/60" />}
            </div>
          </MaybeContextMenuTurn>
        )
      })}
      <div style={{ position: "absolute", top: `${virtualizer.getTotalSize()}px`, width: "100%" }}>
        <RedoSection
          canRedo={canRedo}
          redoTurnCount={redoTurnCount}
          redoGhostTurns={redoGhostTurns}
          onRedoAll={onRedoAll}
          onRedoUpTo={onRedoUpTo}
          sessionTurnCount={sessionTurnCount}
        />
      </div>
    </div>
  )
}

// ── Context menu wrapper ─────────────────────────────────────────────────────

/** Conditionally wraps children in a TurnContextMenu when undo callbacks are available. */
function MaybeContextMenuTurn({
  turn,
  index,
  props,
  children,
}: {
  turn: Turn
  index: number
  props: TimelineInnerProps
  children: React.ReactNode
}) {
  const { hasUndoCallbacks, branchesAtTurn, onRestoreToHere, onOpenBranches, onBranchFromHere } = props

  if (!hasUndoCallbacks || !onRestoreToHere || !onOpenBranches) {
    return <>{children}</>
  }

  const turnBranches = branchesAtTurn ? branchesAtTurn(index) : []

  return (
    <TurnContextMenu
      turnIndex={index}
      branches={turnBranches}
      onRestoreToHere={onRestoreToHere}
      onOpenBranches={onOpenBranches}
      onBranchFromHere={onBranchFromHere}
    >
      {children}
    </TurnContextMenu>
  )
}

// ── Redo section ─────────────────────────────────────────────────────────────

function RedoSection({
  canRedo,
  redoTurnCount,
  redoGhostTurns,
  onRedoAll,
  onRedoUpTo,
  sessionTurnCount,
}: {
  canRedo: boolean
  redoTurnCount: number
  redoGhostTurns: Turn[]
  onRedoAll?: () => void
  onRedoUpTo?: (ghostTurnIndex: number) => void
  sessionTurnCount: number
}) {
  if (!canRedo || !onRedoAll) return null
  return (
    <>
      <UndoRedoBar
        redoTurnCount={redoTurnCount}
        onRedoAll={onRedoAll}
      />
      {redoGhostTurns.length > 0 && (
        <div className="select-none">
          {redoGhostTurns.map((turn, i) => (
            <div key={`ghost-${turn.id}`} className="group/ghost relative opacity-25 hover:opacity-40 transition-opacity">
              <TurnSection
                turn={turn}
                index={sessionTurnCount + i}
                isActive={false}
                activeToolCallId={null}
                expandAll={false}
              />
              {onRedoUpTo && (
                <button
                  onClick={() => onRedoUpTo(i)}
                  className="absolute top-4 right-4 opacity-0 group-hover/ghost:opacity-100 transition-opacity z-10 flex items-center gap-1 text-[10px] text-green-400 hover:text-green-300 bg-elevation-1 border border-border/50 rounded px-2 py-1"
                >
                  <Redo2 className="size-3" />
                  Redo to here
                </button>
              )}
              {i < redoGhostTurns.length - 1 && (
                <Separator className="bg-border/60" />
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ── Turn section ─────────────────────────────────────────────────────────────

interface TurnSectionProps {
  turn: Turn
  index: number
  isActive: boolean
  activeToolCallId: string | null
  expandAll: boolean
  isAgentActive?: boolean
  isSubAgentView?: boolean
  branchCount?: number
  onRestoreToHere?: (turnIndex: number) => void
  onOpenBranches?: (turnIndex: number) => void
  onEditCommand?: (commandName: string) => void
}

const TurnSection = memo(function TurnSection({
  turn,
  index,
  isActive,
  activeToolCallId,
  expandAll,
  isAgentActive = false,
  isSubAgentView = false,
  branchCount = 0,
  onRestoreToHere,
  onOpenBranches,
  onEditCommand,
}: TurnSectionProps) {
  return (
    <div
      className={cn(
        "group relative py-5 px-4 transition-colors",
        isActive && "ring-1 ring-blue-500/30",
      )}
    >
      <TurnHeader
        index={index}
        turn={turn}
        branchCount={branchCount}
        onRestoreToHere={onRestoreToHere}
        onOpenBranches={onOpenBranches}
      />

      <div className="space-y-4">
        {turn.userMessage && (
          <div className={cn("rounded-lg p-3", isSubAgentView ? CARD_STYLES.userAgent : CARD_STYLES.user)}>
            <UserMessage
              content={turn.userMessage}
              timestamp={turn.timestamp}
              label={isSubAgentView ? "Agent" : undefined}
              variant={isSubAgentView ? "agent" : undefined}
              onEditCommand={onEditCommand}
            />
          </div>
        )}

        <ContentBlocks
          blocks={turn.contentBlocks}
          model={turn.model}
          expandAll={expandAll}
          activeToolCallId={activeToolCallId}
          isAgentActive={isAgentActive}
          isSubAgentView={isSubAgentView}
        />
      </div>
    </div>
  )
})

// ── Turn header ──────────────────────────────────────────────────────────────

function TurnHeader({
  index,
  turn,
  branchCount,
  onRestoreToHere,
  onOpenBranches,
}: {
  index: number
  turn: Turn
  branchCount: number
  onRestoreToHere?: (turnIndex: number) => void
  onOpenBranches?: (turnIndex: number) => void
}) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-elevation-2 border border-border/50 text-[10px] font-mono text-muted-foreground shrink-0">
        {index + 1}
      </div>
      {turn.durationMs !== null && (
        <Badge
          variant="outline"
          className="text-[10px] px-1.5 py-0 h-4 border-border/50 text-muted-foreground gap-1"
        >
          <Clock className="w-2.5 h-2.5" />
          {formatDuration(turn.durationMs)}
        </Badge>
      )}
      {turn.timestamp && (
        <span className="text-[10px] text-muted-foreground">
          {new Date(turn.timestamp).toLocaleTimeString()}
        </span>
      )}
      {onRestoreToHere && (
        <button
          onClick={() => onRestoreToHere(index)}
          className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[10px] text-muted-foreground hover:text-amber-400 ml-auto"
          title="Undo this turn and all after it"
        >
          <RotateCcw className="size-3" />
          <span className="hidden sm:inline">Restore</span>
        </button>
      )}
      {branchCount > 0 && onOpenBranches && (
        <div className={cn(!onRestoreToHere ? "ml-auto" : "")}>
          <BranchIndicator
            branchCount={branchCount}
            onClick={() => onOpenBranches(index)}
          />
        </div>
      )}
    </div>
  )
}

// ── Content blocks renderer ──────────────────────────────────────────────────

function ContentBlocks({
  blocks,
  model,
  expandAll,
  activeToolCallId,
  isAgentActive,
  isSubAgentView,
}: {
  blocks: TurnContentBlock[]
  model: string | null
  expandAll: boolean
  activeToolCallId: string | null
  isAgentActive: boolean
  isSubAgentView: boolean
}) {
  const elements: React.ReactNode[] = []
  const assistantCard = isSubAgentView ? CARD_STYLES.subAgent : CARD_STYLES.assistant
  const assistantBorder = isSubAgentView ? BORDER_STYLES.subAgent : BORDER_STYLES.assistant

  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]

    if (block.kind === "thinking") {
      elements.push(
        <div key={`thinking-${i}`} className={cn("rounded-lg p-3", CARD_STYLES.thinking)}>
          <ThinkingBlock blocks={block.blocks} expandAll={expandAll} />
        </div>
      )
      i++
      continue
    }

    if (block.kind === "text") {
      const { toolCalls, nextIndex } = collectToolCalls(blocks, i + 1)

      block.text.forEach((text, ti) => {
        const isLastTextInBlock = ti === block.text.length - 1
        elements.push(
          <div key={`text-${i}-${ti}`} className={cn("rounded-lg p-3", assistantCard)}>
            <AssistantText
              text={text}
              model={model}
              tokenUsage={null}
              label={isSubAgentView ? "Sub Agent" : undefined}
              variant={isSubAgentView ? "subagent" : undefined}
              timestamp={block.timestamp}
            />
            {isLastTextInBlock && toolCalls.length > 0 && (
              <div className={cn("mt-3 pt-3 border-t", assistantBorder)}>
                <CollapsibleToolCalls
                  toolCalls={toolCalls}
                  expandAll={expandAll}
                  activeToolCallId={activeToolCallId}
                  isAgentActive={isAgentActive}
                />
              </div>
            )}
          </div>
        )
      })

      i = nextIndex
      continue
    }

    if (block.kind === "tool_calls") {
      const { toolCalls, nextIndex } = collectToolCalls(blocks, i)
      elements.push(
        <div key={`tools-${i}`} className={cn("rounded-lg p-3", CARD_STYLES.orphanTools)}>
          <CollapsibleToolCalls
            toolCalls={toolCalls}
            expandAll={expandAll}
            activeToolCallId={activeToolCallId}
            isAgentActive={isAgentActive}
          />
        </div>
      )
      i = nextIndex
      continue
    }

    if (block.kind === "sub_agent") {
      elements.push(
        <div key={`agent-${i}`} className={cn("rounded-lg p-3", CARD_STYLES.subAgent)}>
          <SubAgentPanel messages={block.messages} expandAll={expandAll} />
        </div>
      )
      i++
      continue
    }

    if (block.kind === "background_agent") {
      elements.push(
        <div key={`bg-agent-${i}`} className={cn("rounded-lg p-3", CARD_STYLES.thinking)}>
          <BackgroundAgentPanel messages={block.messages} expandAll={expandAll} />
        </div>
      )
      i++
      continue
    }

    i++
  }

  return <>{elements}</>
}

// ── Collapsible tool calls ───────────────────────────────────────────────────

const CollapsibleToolCalls = memo(function CollapsibleToolCalls({
  toolCalls,
  expandAll,
  activeToolCallId,
  isAgentActive = false,
}: {
  toolCalls: ToolCall[]
  expandAll: boolean
  activeToolCallId: string | null
  isAgentActive?: boolean
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const targetRef = useRef<HTMLDivElement | null>(null)

  const hasInProgressCall = isAgentActive && toolCalls.some((tc) => tc.result === null)
  const isOpen = expandAll || manualOpen || hasInProgressCall

  const lastScrolledToolCallRef = useRef<string | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  useEffect(() => {
    if (!activeToolCallId) {
      lastScrolledToolCallRef.current = null
      return
    }
    if (activeToolCallId === lastScrolledToolCallRef.current) return
    if (!toolCalls.some((tc) => tc.id === activeToolCallId)) return
    lastScrolledToolCallRef.current = activeToolCallId
    setManualOpen(true)
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null
        targetRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        })
      })
    })
  }, [activeToolCallId, toolCalls])

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current)
    }
  }, [])

  const toolCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const tc of toolCalls) {
      counts[tc.name] = (counts[tc.name] || 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
  }, [toolCalls])

  const label = toolCallCountLabel(toolCalls.length)

  if (isOpen) {
    return (
      <div className="space-y-2">
        {!expandAll && (
          <button
            onClick={() => setManualOpen(false)}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown className="size-3" />
            <span>{label}</span>
          </button>
        )}
        {toolCalls.map((tc, i) => {
          const isLastWithoutResult = isAgentActive && i === toolCalls.length - 1 && tc.result === null
          return (
            <div
              key={tc.id}
              ref={tc.id === activeToolCallId ? targetRef : undefined}
              className={cn(
                tc.id === activeToolCallId &&
                  "ring-1 ring-blue-500/50 rounded-md"
              )}
            >
              <ToolCallCard toolCall={tc} expandAll={expandAll} isAgentActive={isLastWithoutResult} />
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <button
      onClick={() => setManualOpen(true)}
      className="flex items-center gap-2 w-full rounded-md border border-border/40 bg-elevation-1 px-2.5 py-2 text-left transition-colors hover:bg-elevation-2 hover:border-border/60"
    >
      <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground shrink-0">
        {label}
      </span>
      <div className="flex items-center gap-1 flex-wrap">
        {toolCounts.map(([name, count]) => (
          <Badge
            key={name}
            variant="outline"
            className={cn(
              "text-[10px] px-1.5 py-0 h-4 font-mono",
              getToolBadgeStyle(name)
            )}
          >
            {name}
            {count > 1 ? ` ×${count}` : ""}
          </Badge>
        ))}
      </div>
    </button>
  )
})

// ── Compaction marker ────────────────────────────────────────────────────────

const CompactionMarker = memo(function CompactionMarker({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false)

  const lines = summary.split("\n")
  const title = lines[0].replace(/^\*\*|\*\*$/g, "")
  const details = lines.slice(1)

  return (
    <div className="px-4 py-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-3 w-full group"
      >
        <div className="flex-1 h-px bg-amber-500/20" />
        <div className="flex items-center gap-1.5 text-[11px] text-amber-500/70 group-hover:text-amber-400 transition-colors">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <Minimize2 className="size-3" />
          <span className="font-medium">Compacted</span>
          <span className="text-amber-500/50">&middot;</span>
          <span className="text-amber-500/50 italic">{title}</span>
        </div>
        <div className="flex-1 h-px bg-amber-500/20" />
      </button>

      {open && details.length > 0 && (
        <div className="mt-2 mx-8 rounded-md border border-amber-500/10 bg-amber-500/5 px-3 py-2 text-[11px] text-muted-foreground space-y-0.5">
          {details.map((line, i) => (
            <div key={i} className={cn(
              line.startsWith("- ") && "pl-2 text-muted-foreground",
              line.startsWith("Tools:") && "text-foreground font-medium",
              line.startsWith("Prompts:") && "text-foreground font-medium mt-1",
              line.match(/^\d+ turns/) && "text-foreground",
            )}>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  )
})
