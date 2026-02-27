import { memo } from "react"
import { Clock, RotateCcw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { UserMessage } from "./UserMessage"
import { ThinkingBlock } from "./ThinkingBlock"
import { AssistantText } from "./AssistantText"
import { SubAgentPanel } from "./SubAgentPanel"
import { BackgroundAgentPanel } from "./BackgroundAgentPanel"
import { CollapsibleToolCalls } from "./CollapsibleToolCalls"
import { BranchIndicator } from "@/components/BranchIndicator"
import { collectToolCalls } from "@/lib/timelineHelpers"
import type { Turn, TurnContentBlock } from "@/lib/types"
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

// ── Types ────────────────────────────────────────────────────────────────────

export interface TurnSectionProps {
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

// ── TurnSection ──────────────────────────────────────────────────────────────

export const TurnSection = memo(function TurnSection({
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
