import { useState, useEffect, useRef, useMemo, useId, memo } from "react"
import { ChevronRight, ListTree, Loader2, XCircle } from "lucide-react"
import { ToolCallCard } from "./ToolCallCard"
import { ThinkingBlock } from "./ThinkingBlock"
import type { ToolCall } from "../../../shared/session/types"
import type { ActivityItem } from "@/lib/timelineHelpers"
import { cn } from "@/lib/utils"
import type { SkillMeta } from "@/hooks/useSkillMetadata"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { summarizeToolActivity, toolActivityEntries, visibleToolActivity } from "@/lib/toolActivity"

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
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const targetRef = useRef<HTMLDivElement | null>(null)
  const panelId = useId()
  const statusId = useId()
  const summary = useMemo(() => summarizeToolActivity(toolCalls, isAgentActive), [toolCalls, isAgentActive])
  const hasInProgressCall = summary.running > 0
  const hasUserQuestion = toolCalls.some((call) => call.name === "AskUserQuestion")
  const isOpen = expandAll || hasUserQuestion || (openOverride ?? hasInProgressCall)
  const tailOnly = openOverride === null && hasInProgressCall && !expandAll && !hasUserQuestion
  const entries = useMemo(() => toolActivityEntries(toolCalls, activityItems), [toolCalls, activityItems])
  const tail = useMemo(() => visibleToolActivity(entries, tailOnly, isAgentActive), [entries, tailOnly, isAgentActive])

  const lastScrolledToolCallRef = useRef<string | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  useEffect(() => {
    if (!activeToolCallId) {
      lastScrolledToolCallRef.current = null
      return
    }
    if (activeToolCallId === lastScrolledToolCallRef.current) return
    if (!toolCalls.some((call) => call.id === activeToolCallId)) return
    lastScrolledToolCallRef.current = activeToolCallId
    setOpenOverride(true)
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null
        targetRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
      })
    })
  }, [activeToolCallId, toolCalls])
  useEffect(() => () => {
    if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current)
  }, [])

  function renderCall(call: ToolCall) {
    const isActive = activeToolCallId === call.id
    return (
      <div key={call.id} ref={isActive ? targetRef : undefined} className={cn("min-w-0", isActive && "rounded-lg ring-2 ring-ring")}>
        <ToolCallCard toolCall={call} expandToolPayloads={expandToolPayloads} isAgentActive={isAgentActive && call.result === null} skillMetadata={skillMetadata} />
      </div>
    )
  }

  if (toolCalls.length === 1 && thinkingCount === 0 && !activityItems) {
    return renderCall(toolCalls[0])
  }

  const title = toolCalls.length > 0 ? `${toolCalls.length} tool ${toolCalls.length === 1 ? "call" : "calls"}` : "Thinking"
  const thinkingLabel = thoughtForMs > 0 ? `Thought for ${Math.max(1, Math.round(thoughtForMs / 1000))}s` : thinkingCount > 0 ? "Includes thinking" : ""
  const description = [summary.text, thinkingLabel].filter(Boolean).join(" · ")

  return (
    <div className="min-w-0 rounded-xl border border-border/80 bg-card/50" data-tool-activity="">
      <button
        type="button"
        className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${isOpen ? "Collapse" : "Expand"} ${title}${description ? `: ${description}` : ""}`}
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-describedby={statusId}
        aria-disabled={expandAll || hasUserQuestion || undefined}
        onClick={() => { if (!expandAll && !hasUserQuestion) setOpenOverride(!isOpen) }}
      >
        <ListTree className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-medium text-foreground">{title}</span>
          {description && <span className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{description}</span>}
        </span>
        <span id={statusId} className="flex shrink-0 flex-col items-end gap-1 text-xs">
          {summary.running > 0 && <span className="flex items-center gap-1.5 text-info"><Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />{summary.running} running</span>}
          {summary.failed > 0 && <span className="flex items-center gap-1.5 text-destructive"><XCircle className="size-3.5" aria-hidden="true" />{summary.failed} failed</span>}
          {summary.unavailable > 0 && <span className="text-muted-foreground">{summary.unavailable} no result</span>}
        </span>
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} aria-hidden="true" />
      </button>
      <Collapsible open={isOpen}>
        <CollapsibleContent id={panelId}>
          <div className="min-w-0 border-t border-border/70 px-1 py-1">
            {tail.hidden > 0 && <Button type="button" variant="ghost" size="sm" className="mb-1 ml-2" onClick={() => setOpenOverride(true)}>Show {tail.hidden} earlier {tail.hidden === 1 ? "step" : "steps"}</Button>}
            {tail.visible.map((entry) => entry.kind === "tool_call"
              ? renderCall(entry.toolCall)
              : <div key={`thinking-${entries.filter((item) => item.kind === "thinking").indexOf(entry)}`} className="px-3 py-1"><ThinkingBlock blocks={entry.blocks} expandAll={false} /></div>)}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
})
