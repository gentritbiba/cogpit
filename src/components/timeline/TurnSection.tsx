import { memo, useMemo, useState } from "react"
import { RotateCcw } from "lucide-react"
import { UserMessage } from "./UserMessage"
import { AgentMessageCard } from "./AgentMessageCard"
import { AssistantText } from "./AssistantText"
import { AgentPanel } from "./AgentPanel"
import { HookEventChip } from "./HookEventChip"
import { PlanModeBlock } from "./PlanModeBlock"
import { RecapBanner } from "./RecapBanner"
import { TaskNotificationBlock } from "./TaskNotificationCard"
import { LocalCommandBlock } from "./LocalCommandOutput"
import { CollapsibleToolCalls } from "./CollapsibleToolCalls"
import { DelegatedAttentionRow, DelegatedResultRow } from "./DelegatedResultRow"
import { clockLabel } from "./SessionRow"
import { isSpawnCall, SpawnedSessionRows } from "./SpawnedSessionRows"
import { TurnWorkFold } from "./TurnWorkFold"
import { TurnChangedFiles } from "./TurnChangedFiles"
import { BranchIndicator } from "@/components/BranchIndicator"
import { TurnContextMenu } from "@/components/TurnContextMenu"
import { Button } from "@/components/ui/button"
import { LiveElapsed } from "./AgentStatusIndicator"
import { collectActivity, segmentActivity, type ActivityItem } from "@/lib/timelineHelpers"
import { promptSource } from "@/lib/userMessageContent"
import { getUserMessageImages, getUserMessageText } from "../../../shared/session/parser"
import { deriveSessionStatus } from "../../../shared/session/sessionStatus"
import { WORKING_STATUSES } from "@/lib/sessionActivity"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext, useSessionContextOptional } from "@/contexts/SessionContext"
import { newContextId } from "../../../shared/session/composerContext"
import { useSkillMetadata } from "@/hooks/useSkillMetadata"
import type { SkillMeta } from "@/hooks/useSkillMetadata"
import type { SubAgentMessage, Turn, TurnContentBlock } from "../../../shared/session/types"
import { hasEditToolCalls } from "../../../shared/session/edit-calls"
import { cn } from "@/lib/utils"
import { getTurnDuration } from "@/lib/format"
import { planTurnFold, turnFoldLabel } from "@/lib/turnFold"

// ── Style constants ──────────────────────────────────────────────────────────

/** What the reader typed: their side of the conversation, set apart on the right. */
const PROMPT_BUBBLE = "ml-auto w-fit max-w-[min(85%,44rem)] rounded-2xl rounded-tr-md border border-border/70 bg-prompt-surface px-4 py-2.5"

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
  const { session, isLive, isSubAgentView, undoRedo, actions, pendingInteraction } = useSessionContext()

  const isSessionLive = isLive && session !== null
  // Narrower than `isSessionLive`: only the last turn can still be worked on, so
  // this is what gates in-progress tool state. An unanswered peer message is a
  // property of the session instead — you can answer one from any turn.
  const isAgentActive = isSessionLive && index === (session?.turns.length ?? 0) - 1

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

  // An async question sits mid-turn with work after it, so only the session's
  // pending interaction can say whether it is still waiting on an answer.
  const openQuestionId = pendingInteraction?.type === "question"
    ? pendingInteraction.toolUseId
    : undefined

  return (
    <TurnSectionInner
      turn={turn}
      openQuestionId={openQuestionId}
      index={index}
      branchCount={branchCount}
      isActive={activeTurnIndex === index}
      activeToolCallId={activeToolCallId}
      expandAll={expandAll}
      expandToolPayloads={expandToolPayloads}
      isAgentActive={isAgentActive}
      isSessionLive={isSessionLive}
      isTurnDone={isTurnDone}
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

// ── Prompt context menu ──────────────────────────────────────────────────────

/**
 * Turn actions hang off the user message only: right-clicking anywhere else in
 * a turn keeps the platform's own menu.
 */
function MaybePromptContextMenu({
  index,
  children,
}: {
  index: number
  children: React.ReactNode
}) {
  const { session, isSubAgentView, undoRedo, actions } = useSessionContext()
  const { requestUndo, branchesAtTurn } = undoRedo
  const { handleOpenBranches, handleBranchFromHere } = actions

  // Redo ghosts render past the last real turn — there is nothing to restore to.
  const isGhostTurn = index >= (session?.turns.length ?? 0)

  if (!undoRedo.enabled || isSubAgentView || isGhostTurn || !requestUndo || !handleOpenBranches) {
    return <>{children}</>
  }

  return (
    <TurnContextMenu
      turnIndex={index}
      branches={branchesAtTurn(index)}
      onRestoreToHere={requestUndo}
      onOpenBranches={handleOpenBranches}
      onBranchFromHere={handleBranchFromHere}
    >
      {children}
    </TurnContextMenu>
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
  isSessionLive: boolean
  isTurnDone: boolean
  isMobile: boolean
  cwd: string
  skillMetadata: Map<string, SkillMeta>
  onRestoreToHere?: (turnIndex: number) => void
  onOpenBranches?: (turnIndex: number) => void
  onEditCommand?: (commandName: string) => void
  onExpandCommand?: (commandName: string, args?: string) => Promise<string | null>
  /** Tool call id of an async question the session is still waiting on. */
  openQuestionId?: string
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
  isSessionLive,
  isTurnDone,
  isMobile,
  cwd,
  skillMetadata,
  onRestoreToHere,
  onOpenBranches,
  onEditCommand,
  onExpandCommand,
  openQuestionId,
}: TurnSectionInnerProps) {
  const hasFileChanges =
    hasEditToolCalls(turn.toolCalls, cwd) ||
    turn.subAgentActivity.some((msg) => hasEditToolCalls(msg.toolCalls, cwd))

  const foldPhase = isTurnDone ? "settled" : "working"
  const foldPlan = useMemo(
    () => planTurnFold(turn.contentBlocks, foldPhase, openQuestionId),
    [foldPhase, openQuestionId, turn.contentBlocks],
  )
  // Undefined follows the global setting. A click becomes a local override,
  // so the disclosure never ignores the user while "expand all" is active.
  // A turn mounted mid-work is pinned open from the start: the reader is
  // watching it, and the settle that follows must not fold it under them.
  const [workExpanded, setWorkExpanded] = useState<boolean | undefined>(() => isTurnDone ? undefined : true)
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

  const spawnedAgents = useMemo(() => spawnedAgentActivity(turn), [turn])

  const contentBlockProps = {
    turnId: turn.id,
    originalBlocks: turn.contentBlocks,
    model: turn.model,
    effort: turn.effort,
    expandAll,
    expandToolPayloads,
    activeToolCallId,
    isAgentActive,
    isSessionLive,
    skillMetadata,
    spawnedAgents,
  }

  return (
    <div
      data-turn-index={index}
      className={cn(
        "group relative",
        isMobile ? "px-0 py-4" : "px-4 py-4",
        isActive && "rounded-lg ring-1 ring-ring/40",
      )}
    >
      <div className="flex flex-col gap-2.5">
        {turn.userMessage ? (
          <TurnPrompt
            index={index}
            turn={turn}
            branchCount={branchCount}
            isMobile={isMobile}
            onRestoreToHere={onRestoreToHere}
            onOpenBranches={onOpenBranches}
            onEditCommand={onEditCommand}
            onExpandCommand={onExpandCommand}
          />
        ) : (
          <TurnActions
            index={index}
            branchCount={branchCount}
            isMobile={isMobile}
            onRestoreToHere={onRestoreToHere}
            onOpenBranches={onOpenBranches}
          />
        )}

        {foldPlan.foldable ? (
          <>
            {leadingBlocks.length > 0 && (
              <ContentBlocks
                blocks={leadingBlocks}
                {...contentBlockProps}
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
            />
            {trailingBlocks.length > 0 && (
              <ContentBlocks
                blocks={trailingBlocks}
                {...contentBlockProps}
              />
            )}
          </>
        ) : (
          <ContentBlocks
            blocks={turn.contentBlocks}
            {...contentBlockProps}
          />
        )}

        {isTurnDone && hasFileChanges && (
          <TurnChangedFiles turn={turn} turnIndex={index} cwd={cwd} />
        )}
      </div>
    </div>
  )
})

/**
 * What each agent this turn's spawn calls started has recorded, by the call
 * that started it: its id, latest status and latest words. Agents those
 * agents started are filed under the same call, so they are left out.
 */
function spawnedAgentActivity(turn: Turn): ReadonlyMap<string, SubAgentMessage> {
  const byCall = new Map<string, SubAgentMessage>()
  for (const message of turn.subAgentActivity) {
    const callId = message.parentToolUseId
    if (!callId || message.parentAgentId) continue
    const seen = byCall.get(callId)
    byCall.set(callId, seen
      ? { ...message, agentId: seen.agentId, status: message.status ?? seen.status, text: message.text.length > 0 ? message.text : seen.text }
      : message)
  }
  return byCall
}

// ── The prompt ───────────────────────────────────────────────────────────────

interface TurnActionProps {
  index: number
  branchCount: number
  isMobile: boolean
  onRestoreToHere?: (turnIndex: number) => void
  onOpenBranches?: (turnIndex: number) => void
}

/** Restore and branches, for a turn; shown under its prompt, on hover where there is hover. */
function TurnActions({ index, branchCount, isMobile, onRestoreToHere, onOpenBranches, time }: TurnActionProps & { time?: string }) {
  const clock = time ? clockLabel(time) : ""
  if (!onRestoreToHere && !(branchCount > 0 && onOpenBranches) && !clock) return null
  return (
    <div className="flex min-h-6 items-center justify-end gap-1 text-xs text-muted-foreground">
      <span
        className={cn(
          "flex items-center gap-1 transition-opacity",
          !isMobile && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        )}
      >
        {clock && <time className="px-1 tabular-nums" dateTime={time}>{clock}</time>}
        {onRestoreToHere && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onRestoreToHere(index)}
            className="text-muted-foreground hover:text-foreground"
            title="Undo this turn and all after it"
          >
            <RotateCcw data-icon="inline-start" />
            Restore
          </Button>
        )}
      </span>
      {branchCount > 0 && onOpenBranches && (
        <BranchIndicator
          branchCount={branchCount}
          onClick={() => onOpenBranches(index)}
        />
      )}
    </div>
  )
}

/**
 * What started the turn. The reader's own words sit on the right as theirs;
 * a session reporting back, a background task or a teammate is something that
 * happened, so it runs full width with the rest of the conversation.
 */
function TurnPrompt({
  turn,
  onEditCommand,
  onExpandCommand,
  ...actions
}: TurnActionProps & {
  turn: Turn
  onEditCommand?: (commandName: string) => void
  onExpandCommand?: (commandName: string, args?: string) => Promise<string | null>
}) {
  const content = turn.userMessage!
  const source = useMemo(() => promptSource(getUserMessageText(content)), [content])

  if (source.kind === "silent" && getUserMessageImages(content).length === 0) {
    return <TurnActions {...actions} />
  }

  // Nobody typed these, so they carry no hover row: Restore stays on the
  // context menu, and only branches, which are worth knowing about, show.
  if (source.kind === "event" || source.kind === "wakeup" || source.kind === "attention") {
    return (
      <div className="flex flex-col gap-0.5">
        <MaybePromptContextMenu index={actions.index}>
          {source.kind === "event" && (
            <div data-turn-prompt>
              <UserMessage content={content} timestamp={turn.timestamp} compact />
            </div>
          )}
          {source.kind === "wakeup" && (
            <div data-turn-prompt className="-mx-2">
              <DelegatedResultRow wakeup={source.wakeup} timestamp={turn.timestamp} />
            </div>
          )}
          {source.kind === "attention" && (
            <div data-turn-prompt className="-mx-2">
              <DelegatedAttentionRow childSessionId={source.childSessionId} detail={source.detail} timestamp={turn.timestamp} />
            </div>
          )}
        </MaybePromptContextMenu>
        <TurnActions {...actions} onRestoreToHere={undefined} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5">
      <MaybePromptContextMenu index={actions.index}>
        <div data-turn-prompt className={PROMPT_BUBBLE}>
          <UserMessage
            content={content}
            timestamp={turn.timestamp}
            onEditCommand={onEditCommand}
            onExpandCommand={onExpandCommand}
            compact
          />
        </div>
      </MaybePromptContextMenu>
      <TurnActions {...actions} time={turn.timestamp} />
    </div>
  )
}

// ── Content blocks renderer ──────────────────────────────────────────────────

/**
 * A key that follows a block rather than its position. Live updates re-derive
 * every block, and a late sub-agent flush can insert one mid-turn; a positional
 * key would remount everything after it and silently collapse groups the user
 * had opened.
 */
function blockIdentity(block: TurnContentBlock): string | null {
  switch (block.kind) {
    case "tool_calls":
      return block.toolCalls[0]?.id ?? null
    case "sub_agent":
    case "background_agent":
      return block.messages[0]?.parentToolUseId ?? block.messages[0]?.agentId ?? null
    default:
      return block.timestamp ?? null
  }
}

/** Quoting a reply of this turn into the composer, where the open session has one. */
function useQuoteInReply(turnId: string): ((text: string) => void) | undefined {
  const context = useSessionContextOptional()
  const source = context?.sessionSource
  const sessionId = context?.session?.sessionId
  const add = context?.actions.handleAddComposerContext
  return useMemo(() => {
    if (!add || !source || !sessionId || context.isSubAgentView || !context.permissions.send) return undefined
    return (text: string) => { add({ id: newContextId(), kind: "quote", text, source: { dirName: source.dirName, fileName: source.fileName, sessionId, turnId } }) }
  }, [add, source, sessionId, turnId, context?.isSubAgentView, context?.permissions.send])
}

interface ActivityProps {
  expandAll: boolean
  expandToolPayloads: boolean
  activeToolCallId: string | null
  isAgentActive: boolean
  skillMetadata?: Map<string, SkillMeta>
  /** What the agents this turn started recorded, by the call that started them. */
  spawnedAgents: ReadonlyMap<string, SubAgentMessage>
}

/**
 * A run of thinking and tool calls: grouped work, broken wherever a call
 * started a session or an agent, which shows as its own row.
 */
function ActivityRun({ items, ...props }: ActivityProps & { items: ActivityItem[] }) {
  // Work between two spawns is named after the spawn before it, so a group
  // keeps its identity, and its open state, while calls stream into it.
  let previousSpawn: string | null = null
  const rows = segmentActivity(items, isSpawnCall).map((segment) => {
    if (segment.kind === "spawn") {
      previousSpawn = segment.toolCall.id
      return (
        <SpawnedSessionRows
          key={`spawn:${segment.toolCall.id}`}
          toolCall={segment.toolCall}
          isAgentActive={props.isAgentActive}
          expandToolPayloads={props.expandToolPayloads}
          activity={props.spawnedAgents.get(segment.toolCall.id)}
        />
      )
    }
    // A run without thinking skips activityItems, so a lone call renders as its own row.
    return (
      <CollapsibleToolCalls
        key={previousSpawn ? `after:${previousSpawn}` : "lead"}
        toolCalls={segment.toolCalls}
        expandAll={props.expandAll}
        expandToolPayloads={props.expandToolPayloads}
        activeToolCallId={props.activeToolCallId}
        isAgentActive={props.isAgentActive}
        activityItems={segment.thinkingCount > 0 ? segment.items : undefined}
        thinkingCount={segment.thinkingCount}
        thoughtForMs={segment.thoughtForMs}
        skillMetadata={props.skillMetadata}
      />
    )
  })
  return <div className="flex min-w-0 flex-col">{rows}</div>
}

/** Where the turn's last words are, so only that reply carries the turn's model, time and actions. */
function finalTextIndex(blocks: TurnContentBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index].kind === "text") return index
  }
  return -1
}

function ContentBlocks({
  blocks,
  turnId,
  originalBlocks,
  model,
  effort,
  isSessionLive,
  ...activity
}: ActivityProps & {
  blocks: TurnContentBlock[]
  turnId: string
  originalBlocks: TurnContentBlock[]
  model: string | null
  effort?: string
  isSessionLive: boolean
}) {
  const elements: React.ReactNode[] = []
  const quote = useQuoteInReply(turnId)
  const lastTextIndex = finalTextIndex(originalBlocks)
  // A sub-agent's own block repeats what its row already shows.
  const shownAsRow = (block: TurnContentBlock) => block.kind === "sub_agent" &&
    block.messages.every((message) => message.parentToolUseId && activity.spawnedAgents.has(message.parentToolUseId))

  const keyUses = new Map<string, number>()
  const keyFor = (block: TurnContentBlock, index: number) => {
    const base = blockIdentity(block) ?? `at-${index}`
    const used = keyUses.get(base) ?? 0
    keyUses.set(base, used + 1)
    return used === 0 ? base : `${base}#${used}`
  }

  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]

    if (block.kind === "thinking" || block.kind === "tool_calls") {
      const { items, nextIndex } = collectActivity(blocks, i)
      elements.push(<ActivityRun key={keyFor(block, i)} items={items} {...activity} />)
      i = nextIndex
      continue
    }

    if (block.kind === "text") {
      const { items, nextIndex } = collectActivity(blocks, i + 1)
      const blockIndex = originalBlocks.indexOf(block)
      // The trailing activity sits inside the text element rather than after it,
      // so streaming another paragraph into this block never moves the group to
      // a different element and remounts it.
      elements.push(
        <div key={keyFor(block, i)} className="flex min-w-0 flex-col gap-2.5">
          {block.text.map((text, ti) => (
            <AssistantText
              key={ti}
              text={text}
              model={model}
              effort={effort}
              timestamp={block.timestamp}
              messageKey={`${turnId}:${blockIndex}:${ti}`}
              onQuote={quote}
              showMeta={blockIndex === lastTextIndex && ti === block.text.length - 1}
            />
          ))}
          {items.length > 0 && <ActivityRun items={items} {...activity} />}
        </div>
      )
      i = nextIndex
      continue
    }

    if (block.kind === "queued_prompt") {
      elements.push(
        <div key={keyFor(block, i)} className="flex flex-col gap-1">
          <span className="ml-auto text-xs text-muted-foreground">Sent while it was working</span>
          <div data-queued-prompt className={PROMPT_BUBBLE}>
            <UserMessage content={block.content} timestamp={block.timestamp ?? ""} compact />
          </div>
        </div>
      )
      i++
      continue
    }

    if (block.kind === "agent_message") {
      elements.push(
        <AgentMessageCard
          key={keyFor(block, i)}
          sender={block.sender}
          body={block.body}
          reply={block.reply}
          timestamp={block.timestamp}
          isLive={isSessionLive}
        />
      )
      i++
      continue
    }

    if (block.kind === "sub_agent" || block.kind === "background_agent") {
      if (!shownAsRow(block)) {
        elements.push(
          <AgentPanel
            key={keyFor(block, i)}
            messages={block.messages}
            expandAll={activity.expandAll}
            label={block.kind === "sub_agent" ? "Sub-agent activity" : "Background agent activity"}
            countLabel={block.kind === "sub_agent" ? "subagents active" : "agents active"}
          />
        )
      }
      i++
      continue
    }

    if (block.kind === "hook_event") {
      elements.push(
        <HookEventChip key={keyFor(block, i)} events={block.events} />
      )
      i++
      continue
    }

    if (block.kind === "plan_mode") {
      elements.push(
        <PlanModeBlock
          key={keyFor(block, i)}
          plan={block.plan}
          planFilePath={block.planFilePath}
          status={block.status}
          toolCalls={block.toolCalls}
          expandAll={activity.expandAll}
          expandToolPayloads={activity.expandToolPayloads}
          isAgentActive={activity.isAgentActive}
          skillMetadata={activity.skillMetadata}
        />
      )
      i++
      continue
    }

    if (block.kind === "recap") {
      elements.push(
        <RecapBanner
          key={keyFor(block, i)}
          content={block.content}
        />
      )
      i++
      continue
    }

    if (block.kind === "task_notification") {
      elements.push(
        <TaskNotificationBlock key={keyFor(block, i)} content={block.content} />
      )
      i++
      continue
    }

    if (block.kind === "local_command") {
      elements.push(
        <LocalCommandBlock
          key={keyFor(block, i)}
          content={block.content}
          contextUsage={block.contextUsage}
          usageReport={block.usageReport}
        />
      )
      i++
      continue
    }

    i++
  }

  return <>{elements}</>
}
