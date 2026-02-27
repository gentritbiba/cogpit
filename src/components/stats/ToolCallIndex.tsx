import { useMemo } from "react"
import { AlertTriangle, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { SectionHeading } from "@/components/stats/SectionHeading"
import type { Turn, ToolCall } from "@/lib/types"
import { truncate } from "@/lib/format"
import { formatCost, calculateCost, estimateThinkingTokens, estimateVisibleOutputTokens } from "@/lib/token-costs"
import { getToolColor } from "@/lib/parser"

// ── Helpers ─────────────────────────────────────────────────────────────────

function getToolCallPreview(tc: ToolCall): string {
  const input = tc.input
  if (input.file_path && typeof input.file_path === "string")
    return input.file_path.split("/").slice(-2).join("/")
  if (input.command && typeof input.command === "string")
    return truncate(input.command, 40)
  if (input.pattern && typeof input.pattern === "string")
    return input.pattern
  if (input.query && typeof input.query === "string")
    return truncate(input.query, 40)
  if (input.url && typeof input.url === "string")
    return truncate(input.url, 40)
  return ""
}

function computeTurnCostShares(turns: Turn[]): number[] {
  return turns.map((t) => {
    const u = t.tokenUsage
    if (!u || t.toolCalls.length === 0) return 0
    const estOutput = estimateThinkingTokens(t) + estimateVisibleOutputTokens(t)
    const output = Math.max(estOutput, u.output_tokens)
    return calculateCost({
      model: t.model,
      inputTokens: u.input_tokens,
      outputTokens: output,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
    }) / t.toolCalls.length
  })
}

interface ToolCallGroup {
  calls: Array<{ tc: ToolCall; turnIndex: number }>
  count: number
  estimatedCost: number
}

function groupToolCalls(turns: Turn[], turnCostShares: number[]): Array<[string, ToolCallGroup]> {
  const groups = new Map<string, ToolCallGroup>()
  for (let i = 0; i < turns.length; i++) {
    for (const tc of turns[i].toolCalls) {
      if (!groups.has(tc.name)) {
        groups.set(tc.name, { calls: [], count: 0, estimatedCost: 0 })
      }
      const g = groups.get(tc.name)!
      g.calls.push({ tc, turnIndex: i })
      g.count++
      g.estimatedCost += turnCostShares[i]
    }
  }
  return Array.from(groups.entries()).sort((a, b) => b[1].count - a[1].count)
}

// ── Main Component ──────────────────────────────────────────────────────────

interface ToolCallIndexProps {
  turns: Turn[]
  onJumpToTurn?: (turnIndex: number, toolCallId?: string) => void
}

export function ToolCallIndex({ turns, onJumpToTurn }: ToolCallIndexProps): JSX.Element | null {
  const turnCostShares = useMemo(() => computeTurnCostShares(turns), [turns])

  const toolCallGroups = useMemo(
    () => groupToolCalls(turns, turnCostShares),
    [turns, turnCostShares]
  )

  if (toolCallGroups.length === 0) return null

  return (
    <section>
      <SectionHeading>Tool Calls</SectionHeading>
      <div className="max-h-[320px] overflow-y-auto">
        <div className="flex flex-col gap-0.5 pr-2">
          {toolCallGroups.map(([name, group]) => {
            const colorClass = getToolColor(name)
            return (
              <Collapsible key={name}>
                <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-elevation-1">
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
                  <span className={cn("font-medium", colorClass)}>{name}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {group.estimatedCost > 0 && (
                      <span className="text-[9px] font-mono text-amber-400/70">
                        ~{formatCost(group.estimatedCost)}
                      </span>
                    )}
                    <Badge
                      variant="secondary"
                      className="h-4 px-1.5 text-[10px] font-normal"
                    >
                      {group.count}
                    </Badge>
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="ml-4 flex flex-col gap-0.5 border-l border-border pl-2 pt-0.5">
                    {group.calls.slice(0, 50).map(({ tc, turnIndex }, i) => {
                      const preview = getToolCallPreview(tc)
                      return (
                        <div key={`${tc.id}-${i}`}>
                          <button
                            onClick={() => onJumpToTurn?.(turnIndex, tc.id)}
                            className={cn(
                              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-left transition-colors w-full",
                              tc.isError
                                ? "text-red-400 hover:bg-red-950/30"
                                : "text-muted-foreground hover:bg-elevation-2 hover:text-foreground"
                            )}
                          >
                            {tc.isError && (
                              <AlertTriangle className="size-2.5 shrink-0 text-red-500" />
                            )}
                            <span className="truncate">
                              {preview || tc.id.slice(0, 8)}
                            </span>
                          </button>
                        </div>
                      )
                    })}
                    {group.calls.length > 50 && (
                      <div className="px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        +{group.calls.length - 50} more
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </div>
      </div>
    </section>
  )
}
