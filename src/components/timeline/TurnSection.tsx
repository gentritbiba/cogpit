import { memo, useMemo } from "react"
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
import { CrewStartRows } from "./CrewStartRows"
import { streamsSubagentOnRow } from "./LiveSubagentTranscript"
import { startsCrewSession } from "@/lib/crewCommands"
import { TurnWorkFold } from "./TurnWorkFold"
import { TurnChangedFiles } from "./TurnChangedFiles"
import { BranchIndicator } from "@/components/BranchIndicator"
import { TurnContextMenu } from "@/components/TurnContextMenu"
import { Button } from "@/components/ui/button"
import { LiveElapsed } from "./AgentStatusIndicator"
import { collectActivity, segmentActivity, type ActivityItem } from "@/lib/timelineHelpers"
import { isReaderPrompt, promptSource, type PromptSource } from "@/lib/userMessageContent"
import { InverseColorScheme } from "@/components/InverseColorScheme"
import { getUserMessageImages, getUserMessageText } from "../../../shared/session/parser"
import { useAppContext } from "@/contexts/AppContext"
import { DisclosureScope, revealedBlock, useDisclosureKey, useRevealTarget, useTimelineState } from "./disclosure"
import { WindowedItems, type WindowItem } from "./WindowedItems"
import { useTimelineLiveStatus, useTimelineRowFacts } from "./TimelineRowsProvider"
import { newContextId } from "../../../shared/session/composerContext"
import { useSkillMetadata } from "@/hooks/useSkillMetadata"
import type { SkillMeta } from "@/hooks/useSkillMetadata"
import type { ToolCall, Turn, TurnContentBlock, UserContent } from "../../../shared/session/types"
import { hasEditToolCalls } from "../../../shared/session/edit-calls"
import { cn } from "@/lib/utils"
import { getTurnDuration } from "@/lib/format"
import { planTurnFold, turnFoldLabel } from "@/lib/turnFold"

// ── Style constants ──────────────────────────────────────────────────────────

/** What the reader sent: their side of the conversation, set apart on the right. */
const READER_BUBBLE = "ml-auto w-fit max-w-[min(85%,44rem)] rounded-2xl rounded-tr-md bg-background px-4 py-2.5 text-foreground"

// ── Types ────────────────────────────────────────────────────────────────────

interface TurnSectionProps {
  turn: Turn
  index: number
  /** Stable across prepends; disclosure state inside the row is keyed under it. */
  turnKey: string
  /** The last turn is the only one still being worked on. */
  isLast: boolean
  branchCount?: number
}


// ── TurnSection (thin context bridge → memo'd inner) ────────────────────────

/**
 * Reads only facts that change rarely, so a streamed record re-renders the
 * rows whose turn changed and no others. Only the last row can be working.
 */
export const TurnSection = memo(function TurnSection({ turn, index, turnKey, isLast, branchCount = 0 }: TurnSectionProps) {
  const {
    state: { activeTurnIndex, activeToolCallId, expandAll, expandToolPayloads },
    isMobile,
  } = useAppContext()
  const facts = useTimelineRowFacts()
  const status = useTimelineLiveStatus()

  const isSessionLive = facts?.isLive ?? false
  const isAgentActive = isLast && status.live
  const isTurnDone = !isAgentActive || !status.working
  const cwd = facts?.cwd ?? ""
  const skillMetadata = useSkillMetadata(cwd)
  const isActive = activeTurnIndex === index

  return (
    <DisclosureScope id={turnKey} root>
      <TurnSectionInner
        turn={turn}
        turnKey={turnKey}
        openQuestionId={facts?.openQuestionId}
        index={index}
        branchCount={branchCount}
        isActive={isActive}
        activeToolCallId={isActive ? activeToolCallId : null}
        expandAll={expandAll}
        expandToolPayloads={expandToolPayloads}
        isAgentActive={isAgentActive}
        isSessionLive={isSessionLive}
        isTurnDone={isTurnDone}
        isMobile={isMobile}
        cwd={cwd}
        skillMetadata={skillMetadata}
        onRestoreToHere={facts?.restoreToHere}
        onOpenBranches={facts?.openBranches}
        onEditCommand={facts?.editCommand}
        onExpandCommand={facts?.expandCommand}
      />
    </DisclosureScope>
  )
})

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
  const facts = useTimelineRowFacts()
  // Redo ghosts render past the last real turn — there is nothing to restore to.
  const isGhostTurn = index >= (facts?.turnCount ?? 0)

  if (!facts?.restoreToHere || !facts.openBranches || !facts.branchesAtTurn || isGhostTurn) {
    return <>{children}</>
  }

  return (
    <TurnContextMenu
      turnIndex={index}
      branches={facts.branchesAtTurn(index)}
      onRestoreToHere={facts.restoreToHere}
      onOpenBranches={facts.openBranches}
      onBranchFromHere={facts.branchFromHere}
    >
      {children}
    </TurnContextMenu>
  )
}

// ── Memo'd inner component (skips re-render when display values unchanged) ──

interface TurnSectionInnerProps {
  turn: Turn
  turnKey: string
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
  turnKey,
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
  // A turn first mounted mid-work is pinned open: the reader is watching it,
  // and the settle that follows must not fold it under them. The store keeps
  // that first decision when the row remounts.
  const [workExpanded, setWorkExpanded] = useTimelineState<boolean | undefined>(
    useDisclosureKey("work"),
    () => isTurnDone ? undefined : true,
  )
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

  const blockIndex = useMemo(() => new Map(turn.contentBlocks.map((block, index) => [block, index])), [turn.contentBlocks])
  const liveOnCallRow = useLiveOnCallRow(turn.toolCalls)

  const contentBlockProps: ContentItemsProps = {
    turnId: turn.id,
    blockIndex,
    lastTextIndex: finalTextIndex(turn.contentBlocks),
    liveOnCallRow,
    model: turn.model,
    effort: turn.effort,
    expandAll,
    expandToolPayloads,
    activeToolCallId,
    isAgentActive,
    isSessionLive,
    skillMetadata,
  }

  const keyFor = blockKeyer(blockIndex)
  const items: WindowItem[] = foldPlan.foldable
    ? [
      ...contentItems(leadingBlocks, keyFor, contentBlockProps),
      {
        key: "work-fold",
        render: () => (
          <div data-scroll-anchor="">
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
          </div>
        ),
      },
      ...contentItems(trailingBlocks, keyFor, contentBlockProps),
    ]
    : contentItems(turn.contentBlocks, keyFor, contentBlockProps)

  // Navigation keeps the block holding its target mounted.
  const revealed = revealedBlock(turn, useRevealTarget())
  const pinned = revealed < 0 ? NO_PINS : items.filter((item) => item.blocks && item.blocks[0] <= revealed && revealed <= item.blocks[1]).map((item) => item.key)

  return (
    <div
      data-turn-index={index}
      data-turn-key={turnKey}
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

        <WindowedItems id="blocks" items={items} pinned={pinned} className="flex flex-col gap-2.5" />

        {isTurnDone && hasFileChanges && (
          <div data-scroll-anchor="">
            <TurnChangedFiles turn={turn} turnIndex={index} cwd={cwd} />
          </div>
        )}
      </div>
    </div>
  )
})

/** The calls that stream their sub-agent on their own row, keeping its identity while that set is unchanged. */
function useLiveOnCallRow(toolCalls: ToolCall[]): ReadonlySet<string> {
  const ids = toolCalls.filter(streamsSubagentOnRow).map((call) => call.id).join("\n")
  return useMemo(() => new Set(ids ? ids.split("\n") : []), [ids])
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
 * What the reader sent, drawn on the opposite theme so it is the first thing
 * to find when scrolling back. `messageKey` is how the sticky prompt banner
 * finds it again: "prompt" for the one that opened the turn, the block index
 * for one sent mid-turn.
 */
function ReaderBubble({ messageKey, children }: { messageKey: string; children: React.ReactNode }) {
  return (
    <InverseColorScheme data-reader-prompt={messageKey} className={READER_BUBBLE}>
      {children}
    </InverseColorScheme>
  )
}

/** A prompt nobody typed: a session reporting back, a background task or a teammate. */
function GeneratedPrompt({ source, content, timestamp }: { source: PromptSource; content: UserContent; timestamp: string }) {
  if (source.kind === "wakeup") {
    return (
      <div className="-mx-2">
        <DelegatedResultRow wakeup={source.wakeup} timestamp={timestamp} />
      </div>
    )
  }
  if (source.kind === "attention") {
    return (
      <div className="-mx-2">
        <DelegatedAttentionRow childSessionId={source.childSessionId} detail={source.detail} timestamp={timestamp} />
      </div>
    )
  }
  return <UserMessage content={content} timestamp={timestamp} compact />
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

  if (isReaderPrompt(source, getUserMessageImages(content).length)) {
    return (
      <div className="flex flex-col gap-0.5">
        <MaybePromptContextMenu index={actions.index}>
          <ReaderBubble messageKey="prompt">
            <UserMessage
              content={content}
              timestamp={turn.timestamp}
              onEditCommand={onEditCommand}
              onExpandCommand={onExpandCommand}
              compact
            />
          </ReaderBubble>
        </MaybePromptContextMenu>
        <TurnActions {...actions} time={turn.timestamp} />
      </div>
    )
  }

  if (source.kind === "silent") return <TurnActions {...actions} />

  // Nobody typed these, so they carry no hover row: Restore stays on the
  // context menu, and only branches, which are worth knowing about, show.
  return (
    <div className="flex flex-col gap-0.5">
      <MaybePromptContextMenu index={actions.index}>
        <GeneratedPrompt source={source} content={content} timestamp={turn.timestamp} />
      </MaybePromptContextMenu>
      <TurnActions {...actions} onRestoreToHere={undefined} />
    </div>
  )
}

/** A prompt that arrived while the turn was running, which is the reader's only when they sent it. */
const QueuedPrompt = memo(function QueuedPrompt({ content, timestamp, messageKey }: { content: string; timestamp: string; messageKey: string }) {
  const source = useMemo(() => promptSource(content), [content])
  if (source.kind === "silent") return null
  if (!isReaderPrompt(source, 0)) return <GeneratedPrompt source={source} content={content} timestamp={timestamp} />
  return (
    <div className="flex flex-col gap-1">
      <span className="ml-auto text-xs text-muted-foreground">Sent while it was working</span>
      <ReaderBubble messageKey={messageKey}>
        <UserMessage content={content} timestamp={timestamp} compact />
      </ReaderBubble>
    </div>
  )
})

// ── Content blocks renderer ──────────────────────────────────────────────────

/**
 * A key that follows a block rather than its position. Live updates re-derive
 * every block, and a late sub-agent flush can insert one mid-turn; a positional
 * key would remount everything after it and drop the state of what follows.
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
  const facts = useTimelineRowFacts()
  const source = facts?.sessionSource
  const sessionId = facts?.sessionId
  const add = facts?.addComposerContext
  const allowed = Boolean(facts && !facts.isSubAgentView && facts.canSend)
  return useMemo(() => {
    if (!add || !source || !sessionId || !allowed) return undefined
    return (text: string) => { add({ id: newContextId(), kind: "quote", text, source: { dirName: source.dirName, fileName: source.fileName, sessionId, turnId } }) }
  }, [add, source, sessionId, turnId, allowed])
}

interface ActivityProps {
  expandAll: boolean
  expandToolPayloads: boolean
  activeToolCallId: string | null
  isAgentActive: boolean
  skillMetadata?: Map<string, SkillMeta>
}

/** Item lists are rebuilt on every render; what matters is whether the blocks inside them changed. */
function sameActivityItems(a: readonly ActivityItem[], b: readonly ActivityItem[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((item, index) => {
    const other = b[index]
    if (item.kind === "thinking") return other.kind === "thinking" && item.blocks === other.blocks && item.thoughtForMs === other.thoughtForMs
    return other.kind === "tool_calls" && item.toolCalls === other.toolCalls
  })
}

function sameProps<P extends { items: ActivityItem[] }>(previous: P, next: P): boolean {
  for (const key of Object.keys(next) as (keyof P)[]) {
    if (key === "items") continue
    if (!Object.is(previous[key], next[key])) return false
  }
  return sameActivityItems(previous.items, next.items)
}

/**
 * A run of thinking and tool calls: grouped work, broken wherever a call
 * started crew sessions, which show as their own rows.
 */
const ActivityRun = memo(function ActivityRun({ items, ...props }: ActivityProps & { items: ActivityItem[] }) {
  // Work between two starts is named after the start before it, so a group
  // keeps its identity, and its open state, while calls stream into it.
  let previousSpawn: string | null = null
  const rows = segmentActivity(items, startsCrewSession).map((segment) => {
    if (segment.kind === "spawn") {
      previousSpawn = segment.toolCall.id
      return (
        <CrewStartRows
          key={`spawn:${segment.toolCall.id}`}
          toolCall={segment.toolCall}
          isAgentActive={props.isAgentActive}
          expandToolPayloads={props.expandToolPayloads}
        />
      )
    }
    const key = previousSpawn ? `after:${previousSpawn}` : "lead"
    // A run without thinking skips activityItems, so a lone call renders as its own row.
    return (
      <DisclosureScope key={key} id={key}>
        <CollapsibleToolCalls
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
      </DisclosureScope>
    )
  })
  return <div className="flex min-w-0 flex-col">{rows}</div>
}, sameProps)

/** A text block, with the activity that follows it until the next text. */
const TextRun = memo(function TextRun({
  block,
  blockIndex,
  isFinalText,
  turnId,
  model,
  effort,
  items,
  ...activity
}: ActivityProps & {
  block: Extract<TurnContentBlock, { kind: "text" }>
  blockIndex: number
  isFinalText: boolean
  turnId: string
  model: string | null
  effort?: string
  items: ActivityItem[]
}) {
  const quote = useQuoteInReply(turnId)
  // The trailing activity sits inside the text element rather than after it,
  // so streaming another paragraph into this block never moves the group to
  // a different element and remounts it.
  return (
    <div data-scroll-anchor="" className="flex min-w-0 flex-col gap-2.5">
      {block.text.map((text, ti) => (
        <DisclosureScope key={ti} id={String(ti)}>
          <AssistantText
            text={text}
            model={model}
            effort={effort}
            timestamp={block.timestamp}
            messageKey={`${turnId}:${blockIndex}:${ti}`}
            onQuote={quote}
            showMeta={isFinalText && ti === block.text.length - 1}
          />
        </DisclosureScope>
      ))}
      {items.length > 0 && <ActivityRun items={items} {...activity} />}
    </div>
  )
}, sameProps)

/** Where the turn's last words are, so only that reply carries the turn's model, time and actions. */
function finalTextIndex(blocks: TurnContentBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index].kind === "text") return index
  }
  return -1
}

const NO_PINS: readonly string[] = []

type KeyFor = (block: TurnContentBlock) => string

/** Keys for the blocks of one render, made unique where two blocks share an identity. */
function blockKeyer(blockIndex: ReadonlyMap<TurnContentBlock, number>): KeyFor {
  const keyUses = new Map<string, number>()
  return (block) => {
    const base = blockIdentity(block) ?? `at-${blockIndex.get(block)}`
    const used = keyUses.get(base) ?? 0
    keyUses.set(base, used + 1)
    return used === 0 ? base : `${base}#${used}`
  }
}

type ContentItemsProps = ActivityProps & {
  turnId: string
  /** Each block's index in the turn. */
  blockIndex: ReadonlyMap<TurnContentBlock, number>
  lastTextIndex: number
  /** Calls whose own row streams their sub-agent's live output. */
  liveOnCallRow: ReadonlySet<string>
  model: string | null
  effort?: string
  isSessionLive: boolean
}

/**
 * The blocks of a turn as window items, each its own memoized element under
 * its own disclosure scope: a record that changes one block re-renders that
 * block, and a giant turn mounts only the items near the viewport.
 */
function contentItems(blocks: TurnContentBlock[], keyFor: KeyFor, {
  turnId,
  blockIndex,
  lastTextIndex,
  liveOnCallRow,
  model,
  effort,
  isSessionLive,
  ...activity
}: ContentItemsProps): WindowItem[] {
  const items: WindowItem[] = []
  const indexOf = (block: TurnContentBlock) => blockIndex.get(block) ?? -1
  const push = (key: string, first: TurnContentBlock, last: TurnContentBlock, element: () => React.ReactNode) => {
    items.push({ key, blocks: [indexOf(first), indexOf(last)], render: () => <DisclosureScope id={key}>{element()}</DisclosureScope> })
  }

  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]

    if (block.kind === "thinking" || block.kind === "tool_calls") {
      const { items: activityItems, nextIndex } = collectActivity(blocks, i, indexOf)
      push(keyFor(block), block, blocks[nextIndex - 1], () => <ActivityRun items={activityItems} {...activity} />)
      i = nextIndex
      continue
    }

    if (block.kind === "text") {
      const { items: activityItems, nextIndex } = collectActivity(blocks, i + 1, indexOf)
      const index = indexOf(block)
      push(keyFor(block), block, blocks[nextIndex - 1], () => (
        <TextRun
          block={block}
          blockIndex={index}
          isFinalText={index === lastTextIndex}
          turnId={turnId}
          model={model}
          effort={effort}
          items={activityItems}
          {...activity}
        />
      ))
      i = nextIndex
      continue
    }

    i++
    const key = keyFor(block)
    switch (block.kind) {
      case "queued_prompt":
        push(key, block, block, () => (
          <div data-scroll-anchor="">
            <QueuedPrompt
              content={block.content}
              timestamp={block.timestamp ?? ""}
              messageKey={String(indexOf(block))}
            />
          </div>
        ))
        break
      case "agent_message":
        push(key, block, block, () => (
          <div data-scroll-anchor="">
            <AgentMessageCard
              sender={block.sender}
              body={block.body}
              reply={block.reply}
              timestamp={block.timestamp}
              isLive={isSessionLive}
            />
          </div>
        ))
        break
      case "sub_agent":
      case "background_agent":
        push(key, block, block, () => (
          <div data-scroll-anchor="">
            <AgentPanel
              messages={block.messages}
              expandAll={activity.expandAll}
              label={block.kind === "sub_agent" ? "Sub-agent activity" : "Background agent activity"}
              countLabel={block.kind === "sub_agent" ? "subagents active" : "agents active"}
              liveOnCallRow={liveOnCallRow}
            />
          </div>
        ))
        break
      case "hook_event":
        push(key, block, block, () => <div data-scroll-anchor=""><HookEventChip events={block.events} /></div>)
        break
      case "plan_mode":
        push(key, block, block, () => (
          <div data-scroll-anchor="">
            <PlanModeBlock
              plan={block.plan}
              planFilePath={block.planFilePath}
              status={block.status}
              toolCalls={block.toolCalls}
              expandAll={activity.expandAll}
              expandToolPayloads={activity.expandToolPayloads}
              isAgentActive={activity.isAgentActive}
              skillMetadata={activity.skillMetadata}
            />
          </div>
        ))
        break
      case "recap":
        push(key, block, block, () => <div data-scroll-anchor=""><RecapBanner content={block.content} /></div>)
        break
      case "task_notification":
        push(key, block, block, () => <div data-scroll-anchor=""><TaskNotificationBlock content={block.content} /></div>)
        break
      case "local_command":
        push(key, block, block, () => (
          <div data-scroll-anchor="">
            <LocalCommandBlock
              content={block.content}
              contextUsage={block.contextUsage}
              usageReport={block.usageReport}
            />
          </div>
        ))
        break
    }
  }

  return items
}
