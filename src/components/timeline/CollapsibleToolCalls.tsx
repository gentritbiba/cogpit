import { useState, useEffect, useRef, useMemo, memo } from "react"
import { ChevronRight, ChevronDown } from "lucide-react"
import { ToolCallCard, getToolTextStyle } from "./ToolCallCard"
import { ThinkingBlock } from "./ThinkingBlock"
import { summarizeActivity } from "@/lib/activitySummary"
import type { ToolCall } from "@/lib/types"
import type { ActivityItem } from "@/lib/timelineHelpers"
import type { ActivitySummary } from "@/lib/activitySummary"
import { cn } from "@/lib/utils"
import type { SkillMeta } from "@/hooks/useSkillMetadata"

const THINKING_TEXT_STYLE = "text-violet-400/70"

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
          {clause.added ? <span className="text-green-500/80"> +{clause.added}</span> : null}
          {clause.removed ? <span className="text-red-400/80"> -{clause.removed}</span> : null}
        </span>
      ))}
    </span>
  )
}

export const CollapsibleToolCalls = memo(function CollapsibleToolCalls({
  toolCalls,
  expandAll,
  activeToolCallId,
  isAgentActive = false,
  activityItems,
  thinkingCount = 0,
  thoughtForMs = 0,
  skillMetadata,
}: {
  toolCalls: ToolCall[]
  expandAll: boolean
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

  const toolCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const tc of toolCalls) {
      counts[tc.name] = (counts[tc.name] || 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
  }, [toolCalls])

  const summary = useMemo(
    () => summarizeActivity(toolCalls, { thoughtForMs }),
    [toolCalls, thoughtForMs]
  )

  function renderToolCallCard(tc: ToolCall, isLast: boolean) {
    const isLastWithoutResult = isAgentActive && isLast && tc.result === null
    return (
      <div
        key={tc.id}
        ref={tc.id === activeToolCallId ? targetRef : undefined}
        className={cn(
          tc.id === activeToolCallId && "ring-1 ring-blue-500/50 rounded-md"
        )}
      >
        <ToolCallCard toolCall={tc} expandAll={expandAll} isAgentActive={isLastWithoutResult} skillMetadata={skillMetadata} />
      </div>
    )
  }

  // Single tool call with no thinking → render directly, no collapsible wrapper
  if (toolCalls.length === 1 && thinkingCount === 0 && !activityItems) {
    return <div className="space-y-2">{renderToolCallCard(toolCalls[0], true)}</div>
  }

  if (isOpen) {
    return (
      <div className="space-y-2">
        {!expandAll && !hasUserQuestion && (
          <button
            type="button"
            onClick={() => setOpenOverride(false)}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown className="size-3" />
            {summary.clauses.length > 0 ? (
              <ActivitySummaryLine summary={summary} />
            ) : (
              <span className={cn("font-mono text-[10px]", THINKING_TEXT_STYLE)}>
                Thinking{thinkingCount > 1 ? ` ×${thinkingCount}` : ""}
              </span>
            )}
          </button>
        )}
        {activityItems ? (
          activityItems.map((item, idx) => {
            if (item.kind === "thinking") {
              return (
                <ThinkingBlock key={`thinking-${idx}`} blocks={item.blocks} expandAll={false} />
              )
            }
            const isLastGroup = idx === activityItems.length - 1
            return item.toolCalls.map((tc, ti) =>
              renderToolCallCard(tc, isLastGroup && ti === item.toolCalls.length - 1)
            )
          })
        ) : (
          toolCalls.map((tc, i) =>
            renderToolCallCard(tc, i === toolCalls.length - 1)
          )
        )}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setOpenOverride(true)}
      className="flex items-start gap-2 w-full py-1 text-left transition-colors hover:opacity-80"
    >
      <ChevronRight className="size-3.5 mt-0.5 text-muted-foreground shrink-0" />
      <div className="flex items-center gap-x-2 gap-y-1 flex-wrap">
        {summary.clauses.length > 0 && <ActivitySummaryLine summary={summary} />}
        <div className="flex items-center gap-2 flex-wrap">
          {thinkingCount > 0 && (
            <span className={cn("font-mono text-[10px]", THINKING_TEXT_STYLE)}>
              Thinking{thinkingCount > 1 ? ` ×${thinkingCount}` : ""}
            </span>
          )}
          {toolCounts.map(([name, count]) => (
            <span key={name} className={cn("font-mono text-[10px]", getToolTextStyle(name))}>
              {name}
              {count > 1 ? ` ×${count}` : ""}
            </span>
          ))}
        </div>
      </div>
    </button>
  )
})
