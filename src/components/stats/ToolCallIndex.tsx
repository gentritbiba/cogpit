import { useMemo } from "react"
import { AlertTriangle, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { SectionHeading } from "@/components/stats/SectionHeading"
import type { Turn, ToolCall } from "../../../shared/session/types"
import { truncate } from "@/lib/format"
import { formatCost } from "../../../shared/session/token-costs"
import { priceTokenUsage, type RateTable } from "@/lib/usagePricing"
import { useModelRates } from "@/hooks/useModelRates"
import { getToolPresentation, getToolSummary } from "../../../shared/session/toolSummary"

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
  // Covers Codex exec scripts and MCP calls, whose inputs have no familiar key.
  return truncate(getToolSummary(tc), 40)
}

function computeTurnCostShares(turns: Turn[], rates: RateTable): number[] {
  return turns.map((t) => {
    const u = t.tokenUsage
    if (!u || t.toolCalls.length === 0) return 0
    return priceTokenUsage(rates, t.model, u) / t.toolCalls.length
  })
}

interface ToolCallGroup {
  calls: Array<{ tc: ToolCall; turnIndex: number }>
  count: number
  estimatedCost: number
  styleName: string
}

function groupToolCalls(turns: Turn[], turnCostShares: number[]): Array<[string, ToolCallGroup]> {
  const groups = new Map<string, ToolCallGroup>()
  for (let i = 0; i < turns.length; i++) {
    for (const tc of turns[i].toolCalls) {
      const presentation = getToolPresentation(tc)
      if (!groups.has(presentation.label)) {
        groups.set(presentation.label, {
          calls: [],
          count: 0,
          estimatedCost: 0,
          styleName: presentation.styleName,
        })
      }
      const g = groups.get(presentation.label)!
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

export function ToolCallIndex({ turns, onJumpToTurn }: ToolCallIndexProps): React.JSX.Element | null {
  const rates = useModelRates()
  const turnCostShares = useMemo(() => computeTurnCostShares(turns, rates), [turns, rates])

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
            return (
              <Collapsible key={name}>
                <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-muted">
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none" />
                  <span className="font-medium text-foreground">{name}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {group.estimatedCost > 0 && (
                      <span className="font-mono text-xs text-warning">
                        {formatCost(group.estimatedCost)}
                      </span>
                    )}
                    <Badge
                      variant="secondary"
                      className="font-normal"
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
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => onJumpToTurn?.(turnIndex, tc.id)}
                            className={cn(
                              "h-auto w-full justify-start gap-1 px-1.5 py-0.5 text-left font-mono text-xs font-normal",
                              tc.isError
                                ? "text-destructive hover:bg-destructive/10"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            )}
                          >
                            {tc.isError && (
                              <AlertTriangle className="size-2.5 shrink-0 text-destructive" data-icon="inline-start" />
                            )}
                            <span className="truncate">
                              {preview || tc.id.slice(0, 8)}
                            </span>
                          </Button>
                        </div>
                      )
                    })}
                    {group.calls.length > 50 && (
                      <div className="px-1.5 py-0.5 text-xs text-muted-foreground">
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
