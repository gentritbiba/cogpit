import { useState, useEffect, useRef, useMemo, memo } from "react"
import { planWorkLogTail, workLogTailLabel } from "@/lib/workLogTail"
import { ChevronRight, ChevronDown } from "lucide-react"
import { ToolCallCard, getToolTextStyle } from "./ToolCallCard"
import { ThinkingBlock } from "./ThinkingBlock"
import { summarizeActivity } from "@/lib/activitySummary"
import type { ToolCall } from "../../../shared/session/types"
import type { ActivityItem } from "@/lib/timelineHelpers"
import type { ActivitySummary } from "@/lib/activitySummary"
import { cn } from "@/lib/utils"
import type { SkillMeta } from "@/hooks/useSkillMetadata"
import { getToolPresentation } from "../../../shared/session/toolSummary"
import { Button } from "@/components/ui/button"

const THINKING_TEXT_STYLE = "text-muted-foreground"

/**
 * The Claude Code CLI activity line, e.g.
 * "Made 1 scratchpad edit +68, read 1 file, ran 2 shell commands".
 */
function ActivitySummaryLine({ summary }: { summary: ActivitySummary }) {
  return (
    <span className="text-xs text-muted-foreground">
      {summary.clauses.map((clause, i) => (
        <span key={clause.key}>
          {i > 0 && ", "}
          {i === 0 ? clause.text[0].toUpperCase() + clause.text.slice(1) : clause.text}
          {clause.added ? <span className="text-success"> +{clause.added}</span> : null}
          {clause.removed ? <span className="text-destructive"> -{clause.removed}</span> : null}
        </span>
      ))}
    </span>
  )
}

export const CollapsibleToolCalls = memo(function CollapsibleToolCalls({
  toolCalls,
  expandAll,
  expandToolPayloads,
  activeToolCallId,
  isAgentActive = false,
  activityItems,
  thinkingCount = 0,
  thoughtForMs = 0,
  skillMetadata,
}: {
  toolCalls: ToolCall[]
  expandAll: boolean
  expandToolPayloads: boolean
  activeToolCallId: string | null
  isAgentActive?: boolean
  /** When provided, renders items in order (thinking + tool calls interleaved). */
  activityItems?: ActivityItem[]
  /** Number of thinking blocks in the group (for label). */
  thinkingCount?: number
  /** Time spent thinking in the group, in ms (for the summary line). */
  thoughtForMs?: number
  /** Skill metadata map for Skill tool rendering enrichment. */
  skillMetadata?: Map<string, SkillMeta>
}) {
  // null follows the automatic live-call behavior; once the user toggles the
  // group, their explicit choice takes precedence.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const targetRef = useRef<HTMLDivElement | null>(null)

  const hasInProgressCall = isAgentActive && toolCalls.some((tc) => tc.result === null)
  const hasUserQuestion = toolCalls.some((tc) => tc.name === "AskUserQuestion")
  const isOpen = expandAll || hasUserQuestion || (openOverride ?? hasInProgressCall)
  // A group that opened itself so the user can watch shows only the newest
  // entry; asking for it explicitly always shows the whole group.
  const tailOnly = openOverride === null && hasInProgressCall && !expandAll && !hasUserQuestion

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
    setOpenOverride(true)
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

  // hasError rides along because collapsed is the default for historical turns.
  // Success draws no icon now, so red on the name is the only thing separating a
  // turn where Bash failed from one where it succeeded without expanding it.
  const toolCounts = useMemo(() => {
    const counts = new Map<string, { count: number; styleName: string; hasError: boolean }>()
    for (const tc of toolCalls) {
      const { label, styleName } = getToolPresentation(tc)
      const current = counts.get(label)
      if (current) {
        current.count++
        current.hasError = current.hasError || Boolean(tc.isError)
      } else {
        counts.set(label, { count: 1, styleName, hasError: Boolean(tc.isError) })
      }
    }
    return [...counts].sort((a, b) => b[1].count - a[1].count)
  }, [toolCalls])

  const summary = useMemo(
    () => summarizeActivity(toolCalls, { thoughtForMs }),
    [toolCalls, thoughtForMs]
  )

  function renderToolCallCard(tc: ToolCall, isLast: boolean, groupedBashCalls?: ToolCall[]) {
    const renderedCalls = groupedBashCalls ?? [tc]
    const isLastWithoutResult = isAgentActive && isLast && renderedCalls.some((call) => call.result === null)
    const isActive = activeToolCallId !== null && renderedCalls.some((call) => call.id === activeToolCallId)
    return (
      <div
        key={tc.id}
        ref={isActive ? targetRef : undefined}
        className={cn(
          isActive && "rounded-md ring-1 ring-ring"
        )}
      >
        <ToolCallCard
          toolCall={tc}
          groupedBashCalls={groupedBashCalls}
          expandAll={expandAll}
          expandToolPayloads={expandToolPayloads}
          isAgentActive={isLastWithoutResult}
          skillMetadata={skillMetadata}
        />
      </div>
    )
  }

  function renderToolCallCards(calls: ToolCall[], isLastGroup: boolean) {
    const cards: React.ReactNode[] = []
    let index = 0
    while (index < calls.length) {
      const toolCall = calls[index]
      if (toolCall.name !== "Bash") {
        cards.push(renderToolCallCard(toolCall, isLastGroup && index === calls.length - 1))
        index++
        continue
      }

      let end = index + 1
      while (end < calls.length && calls[end].name === "Bash") end++
      const groupedBashCalls = calls.slice(index, end)
      cards.push(renderToolCallCard(
        toolCall,
        isLastGroup && end === calls.length,
        groupedBashCalls.length > 1 ? groupedBashCalls : undefined,
      ))
      index = end
    }
    return cards
  }

  // Single tool call with no thinking → render directly, no collapsible wrapper
  if (toolCalls.length === 1 && thinkingCount === 0 && !activityItems) {
    return <div className="flex flex-col gap-2">{renderToolCallCards(toolCalls, true)}</div>
  }

  if (isOpen) {
    return (
      <div className="motion-enter flex flex-col gap-2">
        {!expandAll && !hasUserQuestion && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setOpenOverride(false)}
            className="-ml-2 text-muted-foreground"
          >
            <ChevronDown data-icon="inline-start" />
            {summary.clauses.length > 0 ? (
              <ActivitySummaryLine summary={summary} />
            ) : (
              <span className={cn("font-mono text-xs", THINKING_TEXT_STYLE)}>
                Thinking{thinkingCount > 1 ? ` ×${thinkingCount}` : ""}
              </span>
            )}
          </Button>
        )}
        {activityItems ? (
          (() => {
            const tail = planWorkLogTail(activityItems, tailOnly)
            return (
              <>
                {tail.hidden > 0 && (
                  <EarlierSteps count={tail.hidden} onReveal={() => setOpenOverride(true)} />
                )}
                {(() => {
                  const content: React.ReactNode[] = []
                  let index = 0
                  while (index < tail.visible.length) {
                    const item = tail.visible[index]
                    if (item.kind === "thinking") {
                      content.push(<ThinkingBlock key={`thinking-${index}`} blocks={item.blocks} expandAll={false} />)
                      index++
                      continue
                    }

                    const calls = [...item.toolCalls]
                    let end = index + 1
                    while (end < tail.visible.length && tail.visible[end].kind === "tool_calls") {
                      const next = tail.visible[end]
                      if (next.kind === "tool_calls") calls.push(...next.toolCalls)
                      end++
                    }
                    content.push(...renderToolCallCards(calls, end === tail.visible.length))
                    index = end
                  }
                  return content
                })()}
              </>
            )
          })()
        ) : (
          (() => {
            const tail = planWorkLogTail(toolCalls, tailOnly)
            return (
              <>
                {tail.hidden > 0 && (
                  <EarlierSteps count={tail.hidden} onReveal={() => setOpenOverride(true)} />
                )}
                {renderToolCallCards(tail.visible, true)}
              </>
            )
          })()
        )}
      </div>
    )
  }

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => setOpenOverride(true)}
      className="motion-enter h-auto w-full items-start justify-start gap-2 px-0 py-1 text-left whitespace-normal"
    >
      <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" data-icon="inline-start" />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {summary.clauses.length > 0 && <ActivitySummaryLine summary={summary} />}
        <div className="flex flex-wrap items-center gap-2">
          {thinkingCount > 0 && (
            <span className={cn("font-mono text-xs", THINKING_TEXT_STYLE)}>
              Thinking{thinkingCount > 1 ? ` ×${thinkingCount}` : ""}
            </span>
          )}
          {toolCounts.map(([name, { count, styleName, hasError }]) => (
            <span key={name} className={cn("font-mono text-xs", getToolTextStyle(styleName, hasError))}>
              {name}
              {count > 1 ? ` ×${count}` : ""}
            </span>
          ))}
        </div>
      </div>
    </Button>
  )
})

/** Reveals the older head of a working group that is currently tailing. */
function EarlierSteps({ count, onReveal }: { count: number; onReveal: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={onReveal}
      className="-ml-2 text-muted-foreground"
    >
      <ChevronDown data-icon="inline-start" />
      {workLogTailLabel(count)}
    </Button>
  )
}
