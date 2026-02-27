import { useState, useEffect, useRef, useMemo, memo } from "react"
import { ChevronRight, ChevronDown } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ToolCallCard, getToolBadgeStyle } from "./ToolCallCard"
import { toolCallCountLabel } from "@/lib/timelineHelpers"
import type { ToolCall } from "@/lib/types"
import { cn } from "@/lib/utils"

export const CollapsibleToolCalls = memo(function CollapsibleToolCalls({
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
