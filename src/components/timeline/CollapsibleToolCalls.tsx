import { useEffect, useMemo, useId, memo } from "react"
import { Brain, ChevronRight, ListTree, Loader2 } from "lucide-react"
import { ToolCallCard } from "./ToolCallCard"
import { ThinkingBlock } from "./ThinkingBlock"
import type { ToolCall } from "../../../shared/session/types"
import type { ActivityItem } from "@/lib/timelineHelpers"
import { cn } from "@/lib/utils"
import type { SkillMeta } from "@/hooks/useSkillMetadata"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { useDisclosureKey, useRevealTarget, useTimelineState } from "./disclosure"
import { WindowedItems, type WindowItem } from "./WindowedItems"
import { activitySentence, summarizeToolActivity, toolActivityEntries, visibleToolActivity, type ToolActivityEntry } from "@/lib/toolActivity"

const NO_PINS: readonly string[] = []

export const CollapsibleToolCalls = memo(function CollapsibleToolCalls({
  toolCalls, expandAll, expandToolPayloads, activeToolCallId,
  isAgentActive = false, activityItems, thinkingCount = 0, thoughtForMs = 0, skillMetadata,
}: {
  toolCalls: ToolCall[]
  expandAll: boolean
  expandToolPayloads: boolean
  activeToolCallId: string | null
  isAgentActive?: boolean
  activityItems?: ActivityItem[]
  thinkingCount?: number
  thoughtForMs?: number
  skillMetadata?: Map<string, SkillMeta>
}) {
  // Null follows the calls: open while one runs, closed once they settle.
  const [openOverride, setOpenOverride] = useTimelineState<boolean | null>(useDisclosureKey("group"), null)
  const panelId = useId()
  const statusId = useId()
  const summary = useMemo(() => summarizeToolActivity(toolCalls, isAgentActive), [toolCalls, isAgentActive])
  const hasInProgressCall = summary.running > 0
  const hasUserQuestion = toolCalls.some((call) => call.name === "AskUserQuestion")
  const isOpen = expandAll || hasUserQuestion || (openOverride ?? hasInProgressCall)
  const tailOnly = openOverride === null && hasInProgressCall && !expandAll && !hasUserQuestion
  const entries = useMemo(() => toolActivityEntries(toolCalls, activityItems), [toolCalls, activityItems])
  const tail = useMemo(() => visibleToolActivity(entries, tailOnly, isAgentActive), [entries, tailOnly, isAgentActive])

  // Navigation (find, a jump to a call) opens the group holding its target.
  const revealTarget = useRevealTarget()
  const holdsRevealTarget = typeof revealTarget === "string"
    ? toolCalls.some((call) => call.id === revealTarget)
    : Array.isArray(revealTarget) && activityItems?.some((item) => item.kind === "thinking" && item.blocks === revealTarget) === true
  useEffect(() => {
    if (holdsRevealTarget) setOpenOverride(true)
  }, [holdsRevealTarget, setOpenOverride])

  const thinkingOrdinal = useMemo(() => {
    const ordinals = new Map<ToolActivityEntry, number>()
    for (const entry of entries) if (entry.kind === "thinking") ordinals.set(entry, ordinals.size)
    return ordinals
  }, [entries])
  const items: WindowItem[] = tail.visible.map((entry) => entry.kind === "tool_call"
    ? { key: entry.toolCall.id, render: () => renderCall(entry.toolCall) }
    : {
      key: `thinking-${thinkingOrdinal.get(entry)}`,
      blocks: entry.block === undefined ? undefined : [entry.block, entry.block],
      render: () => <div data-scroll-anchor="" className="px-2 py-1"><ThinkingBlock blocks={entry.blocks} /></div>,
    })
  const pinned = revealTarget === null || typeof revealTarget === "number"
    ? NO_PINS
    : typeof revealTarget === "string"
      ? [revealTarget]
      : items.filter((_, index) => {
        const entry = tail.visible[index]
        return entry.kind === "thinking" && revealTarget.includes(entry.blocks[0])
      }).map((item) => item.key)

  function renderCall(call: ToolCall) {
    const isActive = activeToolCallId === call.id
    return (
      <div key={call.id} className={cn("min-w-0", isActive && "rounded-md ring-2 ring-ring")}>
        <ToolCallCard toolCall={call} expandToolPayloads={expandToolPayloads} isAgentActive={isAgentActive && call.result === null} skillMetadata={skillMetadata} />
      </div>
    )
  }

  if (toolCalls.length === 1 && thinkingCount === 0 && !activityItems) {
    return renderCall(toolCalls[0])
  }

  const title = toolCalls.length > 0 ? `${toolCalls.length} tool ${toolCalls.length === 1 ? "call" : "calls"}` : "Thinking"
  const sentence = activitySentence(summary, thoughtForMs, thinkingCount)
  const Icon = toolCalls.length > 0 ? ListTree : Brain

  return (
    <div className="min-w-0" data-tool-activity="" data-scroll-anchor="">
      <button
        type="button"
        className="group/tool flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] leading-5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${isOpen ? "Collapse" : "Expand"} ${title}: ${sentence}`}
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-describedby={statusId}
        aria-disabled={expandAll || hasUserQuestion || undefined}
        onClick={() => { if (!expandAll && !hasUserQuestion) setOpenOverride(!isOpen) }}
      >
        <span className={cn("flex size-4 shrink-0 items-center justify-center text-muted-foreground", hasInProgressCall && "text-info")}>
          {hasInProgressCall
            ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
            : <Icon className="size-3.5" aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={summary.text}>{sentence}</span>
        <span id={statusId} className="flex shrink-0 items-center gap-2.5 text-xs">
          {summary.running > 0 && <span className="text-info">{summary.running} running</span>}
          {summary.failed > 0 && <span className="text-destructive">{summary.failed} failed</span>}
          {summary.awaitingReview > 0 && <span className="text-muted-foreground">{summary.awaitingReview} awaiting review</span>}
          {summary.unavailable > 0 && <span className="text-muted-foreground">{summary.unavailable} no result</span>}
        </span>
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} aria-hidden="true" />
      </button>
      <Collapsible open={isOpen}>
        <CollapsibleContent id={panelId}>
          <div className="ml-[15px] min-w-0 border-l border-border/60 py-0.5 pl-2">
            {tail.hidden > 0 && <Button type="button" variant="ghost" size="xs" className="mb-0.5 text-muted-foreground" onClick={() => setOpenOverride(true)}>Show {tail.hidden} earlier {tail.hidden === 1 ? "step" : "steps"}</Button>}
            <WindowedItems id="calls" items={items} pinned={pinned} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
})
