import { useMemo, useState } from "react"
import { SectionHeading } from "@/components/stats/SectionHeading"
import type { Turn } from "@/lib/types"
import { formatTokenCount } from "@/lib/format"
import { formatCost, calculateCost, estimateThinkingTokens, estimateVisibleOutputTokens } from "@/lib/token-costs"

interface TurnData {
  turn: number
  totalInput: number
  totalOutput: number
  thinkingTokens: number
  visibleTokens: number
  newInput: number
  cacheRead: number
  cacheWrite: number
  hasSubAgents: boolean
  cost: number
}

function computeTurnData(turns: Turn[]): TurnData[] {
  return turns.map((t, i) => {
    const newInput = t.tokenUsage?.input_tokens ?? 0
    const cacheRead = t.tokenUsage?.cache_read_input_tokens ?? 0
    const cacheWrite = t.tokenUsage?.cache_creation_input_tokens ?? 0
    const totalInput = newInput + cacheRead + cacheWrite
    const hasSubAgents = t.subAgentActivity.length > 0

    const thinkingTokens = estimateThinkingTokens(t)
    const visibleTokens = estimateVisibleOutputTokens(t)
    const totalOutput = Math.max(thinkingTokens + visibleTokens, t.tokenUsage?.output_tokens ?? 0)

    const cost = t.tokenUsage
      ? calculateCost({ model: t.model, inputTokens: newInput, outputTokens: totalOutput, cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead })
      : 0

    return {
      turn: i + 1,
      totalInput,
      totalOutput,
      thinkingTokens,
      visibleTokens,
      newInput,
      cacheRead,
      cacheWrite,
      hasSubAgents,
      cost,
    }
  })
}

// ── Chart Tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ data }: { data: TurnData }): JSX.Element {
  return (
    <div className="pointer-events-none absolute left-0 right-0 top-[28px] z-10 px-1">
      <div className="rounded-md border border-border bg-elevation-2 px-2.5 py-2 text-[10px] shadow-lg w-fit">
        <div className="font-medium text-foreground mb-1">Turn {data.turn}</div>
        <div className="flex flex-col gap-0.5 text-muted-foreground">
          <span>Input: <span className="text-blue-400">{formatTokenCount(data.totalInput)}</span>
            <span className="text-[9px] ml-1 opacity-60">
              ({formatTokenCount(data.cacheRead)} cached, {formatTokenCount(data.cacheWrite)} written, {formatTokenCount(data.newInput)} new)
            </span>
          </span>
          <span>Output: <span className="text-green-400">{formatTokenCount(data.totalOutput)}</span>
            {data.thinkingTokens > 0 && (
              <span className="text-[9px] ml-1 opacity-60">
                ({formatTokenCount(data.thinkingTokens)} thinking, {formatTokenCount(data.visibleTokens)} text)
              </span>
            )}
          </span>
          {data.cost > 0 && <span>Cost: <span className="text-amber-400">~{formatCost(data.cost)}</span></span>}
          {data.hasSubAgents && <span className="text-amber-400/70">Has sub-agent activity</span>}
        </div>
      </div>
    </div>
  )
}

// ── Chart Legend ─────────────────────────────────────────────────────────────

function ChartLegend({ padLeft, svgHeight }: { padLeft: number; svgHeight: number }): JSX.Element {
  return (
    <>
      <rect x={padLeft} y={svgHeight - 10} width={6} height={6} rx={1.5} fill="#60a5fa" opacity={0.85} />
      <text x={padLeft + 9} y={svgHeight - 4} className="fill-muted-foreground text-[7px]">Input</text>
      <rect x={padLeft + 38} y={svgHeight - 10} width={6} height={6} rx={1.5} fill="#4ade80" opacity={0.7} />
      <text x={padLeft + 47} y={svgHeight - 4} className="fill-muted-foreground text-[7px]">Output</text>
      <rect x={padLeft + 76} y={svgHeight - 10} width={6} height={6} rx={1.5} fill="#a78bfa" opacity={0.45} />
      <text x={padLeft + 85} y={svgHeight - 4} className="fill-muted-foreground text-[7px]">Think</text>
      <circle cx={padLeft + 112} cy={svgHeight - 7} r={2} fill="#f59e0b" opacity={0.8} />
      <text x={padLeft + 117} y={svgHeight - 4} className="fill-muted-foreground text-[7px]">Agent</text>
    </>
  )
}

// ── Bar Group (single turn) ─────────────────────────────────────────────────

interface BarGroupProps {
  data: TurnData
  index: number
  groupX: number
  barW: number
  groupW: number
  baseY: number
  chartH: number
  maxVal: number
  isHovered: boolean
  onHover: () => void
  padTop: number
}

function BarGroup({ data: d, groupX, barW, groupW, baseY, chartH, maxVal, isHovered, onHover, padTop }: BarGroupProps): JSX.Element {
  const cacheReadH = (d.cacheRead / maxVal) * chartH
  const cacheWriteH = (d.cacheWrite / maxVal) * chartH
  const newInputH = (d.newInput / maxVal) * chartH
  const thinkingH = (d.thinkingTokens / maxVal) * chartH
  const visibleH = (d.visibleTokens / maxVal) * chartH

  return (
    <g onMouseEnter={onHover} style={{ cursor: "crosshair" }}>
      <rect x={groupX} y={padTop} width={groupW} height={chartH} fill="transparent" />

      {isHovered && (
        <rect x={groupX - 1} y={padTop} width={groupW + 2} height={chartH} fill="var(--foreground)" opacity={0.04} rx={2} />
      )}

      {/* Input bar -- left half */}
      {cacheReadH > 0 && (
        <rect x={groupX} y={baseY - cacheReadH} width={barW} height={cacheReadH} rx={1} fill="#60a5fa" opacity={isHovered ? 0.45 : 0.25} />
      )}
      {cacheWriteH > 0 && (
        <rect x={groupX} y={baseY - cacheReadH - cacheWriteH} width={barW} height={cacheWriteH} rx={1} fill="#60a5fa" opacity={isHovered ? 0.7 : 0.5} />
      )}
      {newInputH > 0 && (
        <rect x={groupX} y={baseY - cacheReadH - cacheWriteH - newInputH} width={barW} height={newInputH} rx={1} fill="#60a5fa" opacity={isHovered ? 1 : 0.85} />
      )}

      {/* Output bar -- right half: thinking (dim purple) + visible (bright green) */}
      {thinkingH > 0 && (
        <rect x={groupX + barW + 1} y={baseY - thinkingH} width={barW} height={thinkingH} rx={1} fill="#a78bfa" opacity={isHovered ? 0.7 : 0.45} />
      )}
      {visibleH > 0 && (
        <rect x={groupX + barW + 1} y={baseY - thinkingH - visibleH} width={barW} height={visibleH} rx={1} fill="#4ade80" opacity={isHovered ? 0.95 : 0.7} />
      )}

      {/* Sub-agent indicator dot */}
      {d.hasSubAgents && (
        <circle cx={groupX + groupW / 2} cy={baseY + 5} r={1.5} fill="#f59e0b" opacity={0.8} />
      )}
    </g>
  )
}

// ── Main Chart ──────────────────────────────────────────────────────────────

const SVG_WIDTH = 280
const SVG_HEIGHT = 130
const PAD_TOP = 16
const PAD_BOTTOM = 22
const PAD_LEFT = 36
const PAD_RIGHT = 8
const CHART_W = SVG_WIDTH - PAD_LEFT - PAD_RIGHT
const CHART_H = SVG_HEIGHT - PAD_TOP - PAD_BOTTOM

export function InputOutputChart({ turns }: { turns: Turn[] }): JSX.Element | null {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  const data = useMemo(() => computeTurnData(turns), [turns])

  if (data.length === 0) return null

  const maxVal = Math.max(...data.map((d) => d.totalInput), ...data.map((d) => d.totalOutput))
  if (maxVal === 0) return null

  const groupW = Math.max(5, Math.min(20, CHART_W / data.length))
  const barW = Math.max(2, (groupW - 1) / 2)
  const baseY = PAD_TOP + CHART_H
  const hovered = hoveredIdx !== null ? data[hoveredIdx] : null

  return (
    <section className="relative">
      <SectionHeading>Input / Output Per Turn</SectionHeading>

      {hovered && <ChartTooltip data={hovered} />}

      <svg
        width="100%"
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        {/* Y-axis labels */}
        <text x={PAD_LEFT - 4} y={PAD_TOP} textAnchor="end" dominantBaseline="central" className="fill-muted-foreground text-[8px]">
          {formatTokenCount(maxVal)}
        </text>
        <text x={PAD_LEFT - 4} y={baseY} textAnchor="end" dominantBaseline="central" className="fill-muted-foreground text-[8px]">
          0
        </text>
        {/* Grid line */}
        <line x1={PAD_LEFT} y1={baseY} x2={PAD_LEFT + CHART_W} y2={baseY} stroke="var(--border)" strokeWidth={0.5} />

        {data.map((d, i) => {
          const groupX = PAD_LEFT + (data.length === 1 ? (CHART_W - groupW) / 2 : (i / (data.length - 1)) * (CHART_W - groupW))
          return (
            <BarGroup
              key={i}
              data={d}
              index={i}
              groupX={groupX}
              barW={barW}
              groupW={groupW}
              baseY={baseY}
              chartH={CHART_H}
              maxVal={maxVal}
              isHovered={hoveredIdx === i}
              onHover={() => setHoveredIdx(i)}
              padTop={PAD_TOP}
            />
          )
        })}

        <ChartLegend padLeft={PAD_LEFT} svgHeight={SVG_HEIGHT} />
      </svg>
    </section>
  )
}
