import { memo, useRef, useLayoutEffect, useMemo, useState } from "react"
import { useNearViewport } from "@/hooks/useNearViewport"
import { Clock, RotateCcw } from "lucide-react"
import { UserMessage } from "./UserMessage"
import { AssistantText } from "./AssistantText"
import { SubAgentPanel } from "./SubAgentPanel"
import { BackgroundAgentPanel } from "./BackgroundAgentPanel"
import { HookEventChip } from "./HookEventChip"
import { PlanModeBlock } from "./PlanModeBlock"
import { RecapBanner } from "./RecapBanner"
import { CollapsibleToolCalls } from "./CollapsibleToolCalls"
import { TurnWorkFold } from "./TurnWorkFold"
import { TurnChangedFiles } from "./TurnChangedFiles"
import { BranchIndicator } from "@/components/BranchIndicator"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { LiveElapsed } from "./AgentStatusIndicator"
import { collectActivity } from "@/lib/timelineHelpers"
import { deriveSessionStatus } from "@/lib/sessionStatus"
import { WORKING_STATUSES } from "@/lib/sessionActivity"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { useSkillMetadata } from "@/hooks/useSkillMetadata"
import type { SkillMeta } from "@/hooks/useSkillMetadata"
import type { Turn, TurnContentBlock } from "@/lib/types"
import { cn } from "@/lib/utils"
import { formatDuration, getTurnDuration } from "@/lib/format"
import { planTurnFold, turnFoldLabel } from "@/lib/turnFold"

// ── Style constants ──────────────────────────────────────────────────────────

const CARD_STYLES = {
  user: "border border-border bg-muted/40",
  userAgent: "border border-border bg-muted/25",
} as const

/**
 * One rail for nesting. Depth is the only thing a rail has to communicate, so
 * every nested block shares a single hairline; a nested agent transcript is a
 * genuine structural difference, so it keeps the one accent.
 */
const NEST_RAIL = "border-l border-border/40"
const AGENT_RAIL = "border-l border-border"

// ── Types ────────────────────────────────────────────────────────────────────

interface TurnSectionProps {
  turn: Turn
  index: number
  branchCount?: number
}


// ── TurnSection (thin context bridge → memo'd inner) ────────────────────────

export function TurnSection({ turn, index, branchCount = 0 }: TurnSectionProps) {
  const {
    state: { activeTurnIndex, activeToolCallId, expandAll, expandToolPayloads },
    isMobile,
  } = useAppContext()
  const { session, isLive, isSubAgentView, undoRedo, actions } = useSessionContext()

  const isAgentActive = isLive && session !== null && index === session.turns.length - 1

  // For the last active turn, derive completion from raw messages (immediate on end_turn).
  // For all other turns, they're done by definition.
  let isTurnDone = !isAgentActive
  if (isAgentActive && session) {
    const { status } = deriveSessionStatus(
      session.rawMessages as Array<{ type: string; [key: string]: unknown }>
    )
    isTurnDone = !WORKING_STATUSES.has(status)
  }

  const cwd = session?.cwd ?? ""
  const skillMetadata = useSkillMetadata(cwd)

  return (
    <TurnSectionInner
      turn={turn}
      index={index}
      branchCount={branchCount}
      isActive={activeTurnIndex === index}
      activeToolCallId={activeToolCallId}
      expandAll={expandAll}
      expandToolPayloads={expandToolPayloads}
      isAgentActive={isAgentActive}
      isTurnDone={isTurnDone}
      isSubAgentView={isSubAgentView}
      isMobile={isMobile}
      cwd={cwd}
      skillMetadata={skillMetadata}
      onRestoreToHere={!undoRedo.enabled || isSubAgentView ? undefined : undoRedo.requestUndo}
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
  expandToolPayloads: boolean
  isAgentActive: boolean
  isTurnDone: boolean
  isSubAgentView: boolean
  isMobile: boolean
  cwd: string
  skillMetadata: Map<string, SkillMeta>
  onRestoreToHere?: (turnIndex: number) => void
  onOpenBranches?: (turnIndex: number) => void
  onEditCommand?: (commandName: string) => void
  onExpandCommand?: (commandName: string, args?: string) => Promise<string | null>
}

function TurnWorkLabel({
  turn,
  isTurnDone,
  hiddenToolCalls,
}: {
  turn: Turn
  isTurnDone: boolean
  hiddenToolCalls: number
}) {
  if (isTurnDone) return turnFoldLabel(getTurnDuration(turn), hiddenToolCalls)
  if (!turn.timestamp) return "Working"

  return (
    <span className="inline-flex items-baseline gap-1">
      Working for
      <LiveElapsed
        startTimestamp={turn.timestamp}
        className="text-xs text-inherit"
      />
    </span>
  )
}

const TurnSectionInner = memo(function TurnSectionInner({
  turn,
  index,
  branchCount,
  isActive,
  activeToolCallId,
  expandAll,
  expandToolPayloads,
  isAgentActive,
  isTurnDone,
  isSubAgentView,
  isMobile,
  cwd,
  skillMetadata,
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

  const foldPhase = isTurnDone ? "settled" : "working"
  const foldPlan = useMemo(
    () => planTurnFold(turn.contentBlocks, foldPhase),
    [foldPhase, turn.contentBlocks],
  )
  // Undefined follows the global setting. A click becomes a local override,
  // so the disclosure never ignores the user while "expand all" is active.
  const [workExpanded, setWorkExpanded] = useState<boolean | undefined>(undefined)
  const workVisible = workExpanded ?? (expandAll || !isTurnDone)

  const { leadingBlocks, trailingBlocks } = useMemo(() => {
    if (!foldPlan.foldable) {
      return { leadingBlocks: [] as TurnContentBlock[], trailingBlocks: [] as TurnContentBlock[] }
    }
    const anchor = foldPlan.foldAnchorIndex
    const folded = new Set(foldPlan.foldedIndices)
    return {
      leadingBlocks: turn.contentBlocks.slice(0, anchor),
      // Everything from the anchor on keeps its original order, so expanding
      // never reshuffles the turn.
      trailingBlocks: turn.contentBlocks
        .slice(anchor)
        .filter((_, offset) => workVisible || !folded.has(anchor + offset)),
    }
  }, [foldPlan, turn.contentBlocks, workVisible])

  return (
    <div
      ref={ref}
      data-turn-index={index}
      className={cn(
        "group relative",
        isMobile ? "px-1 py-3" : "px-4 py-5",
        isActive && "rounded-lg ring-1 ring-ring/40",
      )}
    >
      <TurnHeader
        index={index}
        turn={turn}
        branchCount={branchCount}
        isTurnDone={isTurnDone}
        isMobile={isMobile}
        onRestoreToHere={onRestoreToHere}
        onOpenBranches={onOpenBranches}
      />

      {isNear ? (
        <div ref={contentRef} className={cn("flex flex-col", isMobile ? "gap-2" : "gap-3")}>
          {turn.userMessage && (
            <div data-turn-prompt className={cn(
              isMobile ? "rounded-lg p-2.5" : "rounded-lg p-3",
              isSubAgentView ? CARD_STYLES.userAgent : CARD_STYLES.user,
            )}>
              <UserMessage
                content={turn.userMessage}
                timestamp={turn.timestamp}
                onEditCommand={onEditCommand}
                onExpandCommand={onExpandCommand}
                compact={isMobile}
              />
            </div>
          )}

          {foldPlan.foldable ? (
            <>
              {leadingBlocks.length > 0 && (
                <ContentBlocks
                  blocks={leadingBlocks}
                  model={turn.model}
                  expandAll={expandAll}
                  expandToolPayloads={expandToolPayloads}
                  activeToolCallId={activeToolCallId}
                  isAgentActive={isAgentActive}
                  isSubAgentView={isSubAgentView}
                  isMobile={isMobile}
                  skillMetadata={skillMetadata}
                />
              )}
              <TurnWorkFold
                label={
                  <TurnWorkLabel
                    turn={turn}
                    isTurnDone={isTurnDone}
                    hiddenToolCalls={foldPlan.hiddenToolCalls}
                  />
                }
                expanded={workVisible}
                onToggle={() => setWorkExpanded(!workVisible)}
                compact={isMobile}
              />
              {trailingBlocks.length > 0 && (
                <ContentBlocks
                  blocks={trailingBlocks}
                  model={turn.model}
                  expandAll={expandAll}
                  expandToolPayloads={expandToolPayloads}
                  activeToolCallId={activeToolCallId}
                  isAgentActive={isAgentActive}
                  isSubAgentView={isSubAgentView}
                  isMobile={isMobile}
                  skillMetadata={skillMetadata}
                />
              )}
            </>
          ) : (
            <ContentBlocks
              blocks={turn.contentBlocks}
              model={turn.model}
              expandAll={expandAll}
              expandToolPayloads={expandToolPayloads}
              activeToolCallId={activeToolCallId}
              isAgentActive={isAgentActive}
              isSubAgentView={isSubAgentView}
              isMobile={isMobile}
              skillMetadata={skillMetadata}
            />
          )}

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
  isMobile,
  onRestoreToHere,
  onOpenBranches,
}: {
  index: number
  turn: Turn
  branchCount: number
  isTurnDone: boolean
  isMobile: boolean
  onRestoreToHere?: (turnIndex: number) => void
  onOpenBranches?: (turnIndex: number) => void
}) {
  const showLiveTimer = !isTurnDone && !!turn.timestamp
  const durationMs = isTurnDone ? getTurnDuration(turn) : null

  return (
    <div className={cn("flex items-center", isMobile ? "mb-2 gap-1.5" : "mb-4 gap-2")}>
      {/* The turn boundary is carried by the accented user message below; this
          number is a label for cross-referencing panels, not a second cue. */}
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {isMobile ? `Turn ${index + 1}` : index + 1}
      </span>
      <TurnTimer durationMs={durationMs} showLiveTimer={showLiveTimer} timestamp={turn.timestamp} />
      {onRestoreToHere && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onRestoreToHere(index)}
          className={cn(
            "ml-auto text-muted-foreground transition-opacity hover:text-foreground",
            isMobile ? "opacity-70" : "opacity-0 group-hover:opacity-100",
          )}
          title="Undo this turn and all after it"
        >
          <RotateCcw data-icon="inline-start" />
          <span className="hidden sm:inline">Restore</span>
        </Button>
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
      <span className="flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
        <Clock className="size-3" data-icon="inline-start" />
        {formatDuration(durationMs)}
      </span>
    )
  }
  if (showLiveTimer) {
    return (
      <span className="flex items-center gap-1 font-mono text-xs tabular-nums text-info">
        <Clock className="size-3" data-icon="inline-start" />
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
  expandToolPayloads,
  activeToolCallId,
  isAgentActive,
  isSubAgentView,
  isMobile,
  skillMetadata,
}: {
  blocks: TurnContentBlock[]
  model: string | null
  expandAll: boolean
  expandToolPayloads: boolean
  activeToolCallId: string | null
  isAgentActive: boolean
  isSubAgentView: boolean
  isMobile: boolean
  skillMetadata?: Map<string, SkillMeta>
}) {
  const elements: React.ReactNode[] = []
  // Indent for every nested block, so the rails all line up.
  const nestIndent = isMobile ? "ml-0 pl-2" : "ml-1 pl-3"

  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]

    // Group consecutive thinking + tool_calls blocks into one collapsible
    if (block.kind === "thinking" || block.kind === "tool_calls") {
      const { items, toolCalls, thinkingCount, thoughtForMs, nextIndex } = collectActivity(blocks, i)

      // Single tool_calls group with no thinking → render as orphan tool calls
      if (items.length === 1 && items[0].kind === "tool_calls") {
        elements.push(
          <div key={`tools-${i}`} className={cn(NEST_RAIL, nestIndent)}>
            <CollapsibleToolCalls
              toolCalls={toolCalls}
              expandAll={expandAll}
              expandToolPayloads={expandToolPayloads}
              activeToolCallId={activeToolCallId}
              isAgentActive={isAgentActive}
              skillMetadata={skillMetadata}
            />
          </div>
        )
      // Mixed or multiple items → grouped collapsible
      } else {
        elements.push(
          <div key={`activity-${i}`} className={cn(NEST_RAIL, nestIndent)}>
            <CollapsibleToolCalls
              toolCalls={toolCalls}
              expandAll={expandAll}
              expandToolPayloads={expandToolPayloads}
              activeToolCallId={activeToolCallId}
              isAgentActive={isAgentActive}
              activityItems={items}
              thinkingCount={thinkingCount}
              thoughtForMs={thoughtForMs}
              skillMetadata={skillMetadata}
            />
          </div>
        )
      }
      i = nextIndex
      continue
    }

    if (block.kind === "text") {
      const { items, toolCalls, thinkingCount, thoughtForMs, nextIndex } = collectActivity(blocks, i + 1)
      block.text.forEach((text, ti) => {
        const isLastTextInBlock = ti === block.text.length - 1
        const hasFollowingActivity = isLastTextInBlock && (toolCalls.length > 0 || thinkingCount > 0)
        elements.push(
          <div key={`text-${i}-${ti}`}>
            <AssistantText
              text={text}
              model={model}
              timestamp={block.timestamp}
              compact={isMobile}
            />
            {hasFollowingActivity && (
              <div className={cn("mt-1.5", NEST_RAIL, nestIndent)}>
                <CollapsibleToolCalls
                  toolCalls={toolCalls}
                  expandAll={expandAll}
                  expandToolPayloads={expandToolPayloads}
                  activeToolCallId={activeToolCallId}
                  isAgentActive={isAgentActive}
                  activityItems={thinkingCount > 0 ? items : undefined}
                  thinkingCount={thinkingCount}
                  thoughtForMs={thoughtForMs}
                  skillMetadata={skillMetadata}
                />
              </div>
            )}
          </div>
        )
      })
      i = nextIndex
      continue
    }

    if (block.kind === "queued_prompt") {
      elements.push(
        <div
          key={`queued-prompt-${block.timestamp ?? "untimed"}-${block.content}`}
          className={cn(
            isMobile ? "rounded-lg p-2.5" : "rounded-lg p-3",
            isSubAgentView ? CARD_STYLES.userAgent : CARD_STYLES.user,
          )}
        >
          <Badge variant="outline" className="mb-2">Queued while working</Badge>
          <UserMessage content={block.content} timestamp={block.timestamp ?? ""} compact={isMobile} />
        </div>
      )
      i++
      continue
    }

    if (block.kind === "sub_agent") {
      elements.push(
        <div key={`agent-${i}`} className={cn(AGENT_RAIL, nestIndent)}>
          <SubAgentPanel messages={block.messages} expandAll={expandAll} />
        </div>
      )
      i++
      continue
    }

    if (block.kind === "background_agent") {
      elements.push(
        <div key={`bg-agent-${i}`} className={cn(AGENT_RAIL, nestIndent)}>
          <BackgroundAgentPanel messages={block.messages} expandAll={expandAll} />
        </div>
      )
      i++
      continue
    }

    if (block.kind === "hook_event") {
      elements.push(
        <HookEventChip key={`hook-${i}`} events={block.events} />
      )
      i++
      continue
    }

    if (block.kind === "plan_mode") {
      elements.push(
        <PlanModeBlock
          key={`plan-${i}`}
          plan={block.plan}
          planFilePath={block.planFilePath}
          status={block.status}
          toolCalls={block.toolCalls}
          expandAll={expandAll}
          expandToolPayloads={expandToolPayloads}
          isAgentActive={isAgentActive}
          skillMetadata={skillMetadata}
        />
      )
      i++
      continue
    }

    if (block.kind === "recap") {
      elements.push(
        <RecapBanner
          key={`recap-${i}`}
          content={block.content}
          timestamp={block.timestamp}
        />
      )
      i++
      continue
    }

    i++
  }

  return <>{elements}</>
}
