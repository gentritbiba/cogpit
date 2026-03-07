import { useState, useEffect, useRef, useMemo, memo } from "react"
import { ChevronRight, ChevronDown } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ToolCallCard, getToolBadgeStyle } from "./ToolCallCard"
import { ThinkingBlock } from "./ThinkingBlock"
import { toolCallCountLabel, activityCountLabel } from "@/lib/timelineHelpers"
import type { ToolCall } from "@/lib/types"
import type { ActivityItem } from "@/lib/timelineHelpers"
import { cn } from "@/lib/utils"

const THINKING_BADGE_STYLE = "bg-violet-500/5 text-violet-400/40 border-violet-500/10"

export const CollapsibleToolCalls = memo(function CollapsibleToolCalls({
  toolCalls,
  expandAll,
  activeToolCallId,
  isAgentActive = false,
  activityItems,
  thinkingCount = 0,
}: {
  toolCalls: ToolCall[]
  expandAll: boolean
  activeToolCallId: string | null
  isAgentActive?: boolean
  /** When provided, renders items in order (thinking + tool calls interleaved). */
  activityItems?: ActivityItem[]
  /** Number of thinking blocks in the group (for label). */
  thinkingCount?: number
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

  const label = thinkingCount > 0
    ? activityCountLabel(toolCalls.length, thinkingCount)
    : toolCallCountLabel(toolCalls.length)

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
        <ToolCallCard toolCall={tc} expandAll={expandAll} isAgentActive={isLastWithoutResult} />
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
        {!expandAll && (
          <button
            onClick={() => setManualOpen(false)}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown className="size-3" />
            {toolCalls.length > 0 ? (
              <span>{label}</span>
            ) : (
              <Badge
                variant="outline"
                className={cn("text-[10px] px-1.5 py-0 h-4 font-mono", THINKING_BADGE_STYLE)}
              >
                Thinking{thinkingCount > 1 ? ` ×${thinkingCount}` : ""}
              </Badge>
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
      onClick={() => setManualOpen(true)}
      className="flex items-center gap-2 w-full py-1 text-left transition-colors hover:opacity-80"
    >
      <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
      {toolCalls.length > 0 && (
        <span className="text-xs text-muted-foreground shrink-0">
          {label}
        </span>
      )}
      <div className="flex items-center gap-1 flex-wrap">
        {thinkingCount > 0 && (
          <Badge
            variant="outline"
            className={cn("text-[10px] px-1.5 py-0 h-4 font-mono", THINKING_BADGE_STYLE)}
          >
            Thinking{thinkingCount > 1 ? ` ×${thinkingCount}` : ""}
          </Badge>
        )}
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
