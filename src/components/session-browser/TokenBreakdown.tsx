import { useState, useMemo } from "react"
import { ChevronDown } from "lucide-react"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import {
  shortenModel,
  computeAgentBreakdown,
  computeModelBreakdown,
  computeCacheBreakdown,
} from "@/lib/format"
import type { ParsedSession } from "@/lib/types"
import { BreakdownRow } from "./StatCards"

// ── Helpers ────────────────────────────────────────────────────────────────

function toPercent(part: number, total: number): number {
  if (total === 0) return 0
  return (part / total) * 100
}

// ── Cache Efficiency Bar ───────────────────────────────────────────────────

interface CacheBarSegment {
  className: string
  percent: number
  label: string
}

function CacheEfficiencyBar({
  cacheRead,
  newInput,
  cacheWrite,
  total,
}: {
  cacheRead: number
  newInput: number
  cacheWrite: number
  total: number
}): React.ReactElement {
  const segments: CacheBarSegment[] = [
    { className: "bg-emerald-500/70", percent: toPercent(cacheRead, total), label: "read" },
    { className: "bg-blue-500/70", percent: toPercent(newInput, total), label: "new" },
    { className: "bg-amber-500/70", percent: toPercent(cacheWrite, total), label: "write" },
  ]

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Cache Efficiency
      </span>
      {/* Stacked bar */}
      <div className="h-2 w-full rounded-full overflow-hidden flex bg-border/30">
        {segments.map((seg) =>
          seg.percent > 0 ? (
            <div
              key={seg.label}
              className={cn("h-full", seg.className)}
              style={{ width: `${seg.percent}%` }}
            />
          ) : null
        )}
      </div>
      {/* Labels */}
      <div className="flex justify-between text-[9px] text-muted-foreground">
        {segments.map((seg) => (
          <span key={seg.label} className="flex items-center gap-1">
            <span className={cn("inline-block size-1.5 rounded-full", seg.className)} />
            {seg.percent.toFixed(0)}% {seg.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export function TokenBreakdown({ session }: { session: ParsedSession }): React.ReactElement | null {
  const [open, setOpen] = useState(false)

  const agentBreakdown = useMemo(
    () => computeAgentBreakdown(session.turns),
    [session.turns],
  )
  const modelBreakdown = useMemo(
    () => computeModelBreakdown(session.turns, shortenModel),
    [session.turns],
  )
  const cacheBreakdown = useMemo(
    () => computeCacheBreakdown(session.turns),
    [session.turns],
  )

  const hasSubAgents =
    agentBreakdown.subAgents.input > 0 || agentBreakdown.subAgents.output > 0
  const hasMultipleModels = modelBreakdown.length > 1

  // If there's nothing interesting to show, skip the section
  if (!hasSubAgents && !hasMultipleModels && cacheBreakdown.total === 0) return null

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="py-3">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 group">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-l-2 border-blue-500/30 pl-2 flex-1 text-left">
          Token Breakdown
        </h3>
        <ChevronDown
          className={cn(
            "size-3 text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-2 flex flex-col gap-3">
        {/* By Agent */}
        {hasSubAgents && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              By Agent
            </span>
            <BreakdownRow
              label="Main Agent"
              input={agentBreakdown.mainAgent.input + agentBreakdown.mainAgent.cacheRead + agentBreakdown.mainAgent.cacheWrite}
              output={agentBreakdown.mainAgent.output}
              cost={agentBreakdown.mainAgent.cost}
            />
            <BreakdownRow
              label="Sub-Agents"
              input={agentBreakdown.subAgents.input + agentBreakdown.subAgents.cacheRead + agentBreakdown.subAgents.cacheWrite}
              output={agentBreakdown.subAgents.output}
              cost={agentBreakdown.subAgents.cost}
            />
          </div>
        )}

        {/* By Model */}
        {hasMultipleModels && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              By Model
            </span>
            {modelBreakdown.map((m) => (
              <BreakdownRow
                key={m.model}
                label={m.shortName}
                input={m.input + m.cacheRead + m.cacheWrite}
                output={m.output}
                cost={m.cost}
              />
            ))}
          </div>
        )}

        {/* Cache Efficiency */}
        {cacheBreakdown.total > 0 && (
          <CacheEfficiencyBar
            cacheRead={cacheBreakdown.cacheRead}
            newInput={cacheBreakdown.newInput}
            cacheWrite={cacheBreakdown.cacheWrite}
            total={cacheBreakdown.total}
          />
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
