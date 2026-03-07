import { memo, useRef, useLayoutEffect } from "react"
import { useNearViewport } from "@/hooks/useNearViewport"
import { Clock, RotateCcw } from "lucide-react"
import { UserMessage } from "./UserMessage"
import { AssistantText } from "./AssistantText"
import { SubAgentPanel } from "./SubAgentPanel"
import { BackgroundAgentPanel } from "./BackgroundAgentPanel"
import { CollapsibleToolCalls } from "./CollapsibleToolCalls"
import { TurnChangedFiles } from "./TurnChangedFiles"
import { BranchIndicator } from "@/components/BranchIndicator"
import { LiveElapsed } from "./AgentStatusIndicator"
import { collectActivity } from "@/lib/timelineHelpers"
import { deriveSessionStatus } from "@/lib/sessionStatus"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import type { Turn, TurnContentBlock } from "@/lib/types"
import { cn } from "@/lib/utils"
import { formatDuration, getTurnDuration } from "@/lib/format"

// ── Style constants ──────────────────────────────────────────────────────────

const CARD_STYLES = {
  user:      "bg-blue-500/[0.12] border border-blue-500/20",
  userAgent: "bg-green-500/[0.12] border border-green-500/20",
} as const

// ── Types ────────────────────────────────────────────────────────────────────

interface TurnSectionProps {
  turn: Turn
  index: number
  branchCount?: number
}

/** Statuses that indicate the agent is still working (turn not yet done). */
const ACTIVE_STATUSES = new Set(["thinking", "tool_use", "processing"])

// ── TurnSection (thin context bridge → memo'd inner) ────────────────────────

export function TurnSection({ turn, index, branchCount = 0 }: TurnSectionProps) {
  const { state: { activeTurnIndex, activeToolCallId, expandAll } } = useAppContext()
  const { session, isLive, isSubAgentView, undoRedo, actions } = useSessionContext()

  const isAgentActive = isLive && session !== null && index === session.turns.length - 1

  // For the last active turn, derive completion from raw messages (immediate on end_turn).
  // For all other turns, they're done by definition.
  let isTurnDone = !isAgentActive
  if (isAgentActive && session) {
    const { status } = deriveSessionStatus(
      session.rawMessages as Array<{ type: string; [key: string]: unknown }>
    )
    isTurnDone = !ACTIVE_STATUSES.has(status)
  }

  return (
    <TurnSectionInner
      turn={turn}
      index={index}
      branchCount={branchCount}
      isActive={activeTurnIndex === index}
      activeToolCallId={activeToolCallId}
      expandAll={expandAll}
      isAgentActive={isAgentActive}
      isTurnDone={isTurnDone}
      isSubAgentView={isSubAgentView}
      cwd={session?.cwd ?? ""}
      onRestoreToHere={isSubAgentView ? undefined : undoRedo.requestUndo}
      onOpenBranches={actions.handleOpenBranches}
      onEditCommand={actions.handleEditCommand}
      onExpandCommand={actions.handleExpandCommand}
    />
  )
}

// ── Memo'd inner component (skips re-render when display values unchanged) ──

interface TurnSectionInnerProps {
  turn: Turn
  index: number
  branchCount: number
  isActive: boolean
  activeToolCallId: string | null
  expandAll: boolean
  isAgentActive: boolean
  isTurnDone: boolean
  isSubAgentView: boolean
  cwd: string
  onRestoreToHere?: (turnIndex: number) => void
  onOpenBranches?: (turnIndex: number) => void
  onEditCommand?: (commandName: string) => void
  onExpandCommand?: (commandName: string, args?: string) => Promise<string | null>
}

const TurnSectionInner = memo(function TurnSectionInner({
  turn,
  index,
  branchCount,
  isActive,
  activeToolCallId,
  expandAll,
  isAgentActive,
  isTurnDone,
  isSubAgentView,
  cwd,
  onRestoreToHere,
  onOpenBranches,
  onEditCommand,
  onExpandCommand,
}: TurnSectionInnerProps) {
  const { ref, isNear } = useNearViewport()

  // Measure actual content height while visible so the placeholder preserves it
  // exactly when the turn scrolls out of the viewport zone (prevents scroll jumping).
  const contentRef = useRef<HTMLDivElement>(null)
  const lastHeightRef = useRef(0)

  useLayoutEffect(() => {
    if (isNear && contentRef.current) {
      lastHeightRef.current = contentRef.current.offsetHeight
    }
  }, [isNear])

  const hasFileChanges =
    turn.toolCalls.some((tc) => tc.name === "Edit" || tc.name === "Write") ||
    turn.subAgentActivity.some((msg) =>
      msg.toolCalls.some((tc) => tc.name === "Edit" || tc.name === "Write"),
    )

  return (
    <div
      ref={ref}
      className={cn(
        "group relative py-5 px-4",
        isActive && "ring-1 ring-blue-500/30",
      )}
    >
      <TurnHeader
        index={index}
        turn={turn}
        branchCount={branchCount}
        isTurnDone={isTurnDone}
        onRestoreToHere={onRestoreToHere}
        onOpenBranches={onOpenBranches}
      />

      {isNear ? (
        <div ref={contentRef} className="space-y-3">
          {turn.userMessage && (
            <div className={cn("rounded-2xl p-3", isSubAgentView ? CARD_STYLES.userAgent : CARD_STYLES.user)}>
              <UserMessage
                content={turn.userMessage}
                timestamp={turn.timestamp}
                onEditCommand={onEditCommand}
                onExpandCommand={onExpandCommand}
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

          {isTurnDone && hasFileChanges && (
            <TurnChangedFiles turn={turn} turnIndex={index} cwd={cwd} />
          )}
        </div>
      ) : (
        <div style={{ minHeight: lastHeightRef.current || estimateTurnHeight(turn) }} />
      )}
    </div>
  )
})

// ── Height estimation for turns that haven't been measured yet ────────────────

function estimateTurnHeight(turn: Turn): number {
  return Math.max(60, (turn.userMessage ? 40 : 0) + turn.contentBlocks.length * 60)
}

// ── Turn header ──────────────────────────────────────────────────────────────

function TurnHeader({
  index,
  turn,
  branchCount,
  isTurnDone,
  onRestoreToHere,
  onOpenBranches,
}: {
  index: number
  turn: Turn
  branchCount: number
  isTurnDone: boolean
  onRestoreToHere?: (turnIndex: number) => void
  onOpenBranches?: (turnIndex: number) => void
}) {
  const showLiveTimer = !isTurnDone && !!turn.timestamp
  const durationMs = isTurnDone ? getTurnDuration(turn) : null

  return (
    <div className="flex items-center gap-2 mb-4">
      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-elevation-2 border border-border/50 text-[10px] font-mono text-muted-foreground shrink-0">
        {index + 1}
      </div>
      <TurnTimer durationMs={durationMs} showLiveTimer={showLiveTimer} timestamp={turn.timestamp} />
      {turn.timestamp && (
        <span className="text-[10px] text-muted-foreground/40">
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
        <div className={cn(!onRestoreToHere && "ml-auto")}>
          <BranchIndicator
            branchCount={branchCount}
            onClick={() => onOpenBranches(index)}
          />
        </div>
      )}
    </div>
  )
}

// ── Turn timer ───────────────────────────────────────────────────────────────

function TurnTimer({
  durationMs,
  showLiveTimer,
  timestamp,
}: {
  durationMs: number | null
  showLiveTimer: boolean
  timestamp: string
}): React.ReactElement | null {
  if (durationMs !== null) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground/60 font-mono tabular-nums">
        <Clock className="w-2.5 h-2.5" />
        {formatDuration(durationMs)}
      </span>
    )
  }
  if (showLiveTimer) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-amber-400/70 font-mono tabular-nums">
        <Clock className="w-2.5 h-2.5 animate-pulse" />
        <LiveElapsed startTimestamp={timestamp} className="tabular-nums" />
      </span>
    )
  }
  return null
}

// ── Content blocks renderer ──────────────────────────────────────────────────

function ContentBlocks({
  blocks,
  model,
  expandAll,
  activeToolCallId,
  isAgentActive,
  isSubAgentView: _isSubAgentView,
}: {
  blocks: TurnContentBlock[]
  model: string | null
  expandAll: boolean
  activeToolCallId: string | null
  isAgentActive: boolean
  isSubAgentView: boolean
}) {
  const elements: React.ReactNode[] = []

  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]

    // Group consecutive thinking + tool_calls blocks into one collapsible
    if (block.kind === "thinking" || block.kind === "tool_calls") {
      const { items, toolCalls, thinkingCount, nextIndex } = collectActivity(blocks, i)

      // Single tool_calls group with no thinking → render as orphan tool calls
      if (items.length === 1 && items[0].kind === "tool_calls") {
        elements.push(
          <div key={`tools-${i}`} className="border-l-2 border-border/40 pl-3 ml-1">
            <CollapsibleToolCalls
              toolCalls={toolCalls}
              expandAll={expandAll}
              activeToolCallId={activeToolCallId}
              isAgentActive={isAgentActive}
            />
          </div>
        )
      // Mixed or multiple items → grouped collapsible
      } else {
        elements.push(
          <div key={`activity-${i}`} className="border-l-2 border-border/40 pl-3 ml-1">
            <CollapsibleToolCalls
              toolCalls={toolCalls}
              expandAll={expandAll}
              activeToolCallId={activeToolCallId}
              isAgentActive={isAgentActive}
              activityItems={items}
              thinkingCount={thinkingCount}
            />
          </div>
        )
      }
      i = nextIndex
      continue
    }

    if (block.kind === "text") {
      const { items, toolCalls, thinkingCount, nextIndex } = collectActivity(blocks, i + 1)
      block.text.forEach((text, ti) => {
        const isLastTextInBlock = ti === block.text.length - 1
        const hasFollowingActivity = isLastTextInBlock && (toolCalls.length > 0 || thinkingCount > 0)
        elements.push(
          <div key={`text-${i}-${ti}`}>
            <AssistantText
              text={text}
              model={model}
              tokenUsage={null}
              timestamp={block.timestamp}
            />
            {hasFollowingActivity && (
              <div className="mt-1.5 border-l-2 border-border/40 pl-3 ml-1">
                <CollapsibleToolCalls
                  toolCalls={toolCalls}
                  expandAll={expandAll}
                  activeToolCallId={activeToolCallId}
                  isAgentActive={isAgentActive}
                  activityItems={thinkingCount > 0 ? items : undefined}
                  thinkingCount={thinkingCount}
                />
              </div>
            )}
          </div>
        )
      })
      i = nextIndex
      continue
    }

    if (block.kind === "sub_agent") {
      elements.push(
        <div key={`agent-${i}`} className="border-l-2 border-indigo-500/30 pl-3 ml-1">
          <SubAgentPanel messages={block.messages} expandAll={expandAll} />
        </div>
      )
      i++
      continue
    }

    if (block.kind === "background_agent") {
      elements.push(
        <div key={`bg-agent-${i}`} className="border-l-2 border-violet-500/30 pl-3 ml-1">
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
