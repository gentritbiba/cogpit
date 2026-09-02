import { useMemo, useState } from "react"
import { SectionHeading } from "@/components/stats/SectionHeading"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { formatTokenCount } from "@/lib/format"
import type { Turn } from "../../../shared/session/types"
import {
  ATTRIBUTION_DIMENSION_LABELS,
  aggregateAttribution,
  attributedDimensions,
  type AttributionBucket,
  type AttributionDimension,
} from "../../../shared/session/attributionStats"

// ── Row ─────────────────────────────────────────────────────────────────────

interface BucketRowProps {
  bucket: AttributionBucket
  maxTotal: number
}

function BucketRow({ bucket, maxTotal }: BucketRowProps): React.JSX.Element {
  const total = bucket.inputTokens + bucket.outputTokens
  const share = maxTotal > 0 ? total / maxTotal : 0
  const inputShare = total > 0 ? (bucket.inputTokens / total) * share : 0
  const outputShare = total > 0 ? (bucket.outputTokens / total) * share : 0

  return (
    <li
      className="rounded-md border bg-card px-2.5 py-1.5"
      title={`${bucket.name} — ${bucket.turns} ${bucket.turns === 1 ? "turn" : "turns"}, ${formatTokenCount(bucket.inputTokens)} input, ${formatTokenCount(bucket.outputTokens)} output`}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={bucket.isUnattributed ? "truncate text-muted-foreground" : "truncate text-foreground"}>
          {bucket.name}
        </span>
        <span className="ml-2 flex shrink-0 items-center gap-1.5 tabular-nums text-muted-foreground">
          <span>{bucket.turns} {bucket.turns === 1 ? "turn" : "turns"}</span>
          <span className="opacity-40">·</span>
          <span>{formatTokenCount(total)}</span>
        </span>
      </div>
      <div className="mt-1.5 flex h-1 gap-[2px]" aria-hidden="true">
        <div
          className={bucket.isUnattributed ? "rounded-xs bg-info/35" : "rounded-xs bg-info/85"}
          style={{ width: `${inputShare * 100}%` }}
        />
        <div
          className={bucket.isUnattributed ? "rounded-xs bg-success/35" : "rounded-xs bg-success/70"}
          style={{ width: `${outputShare * 100}%` }}
        />
      </div>
    </li>
  )
}

// ── Legend ──────────────────────────────────────────────────────────────────

function Legend(): React.JSX.Element {
  return (
    <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-xs bg-info/85" />
        Input
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-xs bg-success/70" />
        Output
      </span>
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────────────

/**
 * What drove the session — skills, plugins, MCP servers/tools, subagent types —
 * with the turns and tokens each accounted for. Claude Code tags assistant
 * records with this from 2.1.17x on; older transcripts render nothing.
 */
export function AttributionPanel({ turns }: { turns: Turn[] }): React.JSX.Element | null {
  const dimensions = useMemo(() => attributedDimensions(turns), [turns])
  const [selected, setSelected] = useState<AttributionDimension | null>(null)
  const dimension = selected && dimensions.includes(selected) ? selected : dimensions[0]

  const buckets = useMemo(
    () => (dimension ? aggregateAttribution(turns, dimension) : []),
    [turns, dimension],
  )

  if (!dimension) return null

  const maxTotal = Math.max(...buckets.map((b) => b.inputTokens + b.outputTokens))

  return (
    <section>
      <SectionHeading>Attribution</SectionHeading>

      {dimensions.length > 1 && (
        <ToggleGroup
          aria-label="Attribution dimension"
          value={[dimension]}
          onValueChange={(values) => {
            const next = values[0]
            if (typeof next === "string") setSelected(next as AttributionDimension)
          }}
          variant="outline"
          size="sm"
          className="mb-2 flex-wrap"
        >
          {dimensions.map((d) => (
            <ToggleGroupItem key={d} value={d}>
              {ATTRIBUTION_DIMENSION_LABELS[d]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}

      <ul className="flex max-h-[280px] flex-col gap-1 overflow-y-auto pr-0.5">
        {buckets.map((bucket) => (
          <BucketRow key={bucket.name} bucket={bucket} maxTotal={maxTotal} />
        ))}
      </ul>

      <Legend />
    </section>
  )
}
