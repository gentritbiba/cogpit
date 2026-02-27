import { useMemo, useState } from "react"
import { SectionHeading } from "@/components/stats/SectionHeading"
import type { Turn } from "@/lib/types"

const SVG_WIDTH = 280
const SVG_HEIGHT = 32

export function ActivityHeatmap({ turns }: { turns: Turn[] }): JSX.Element | null {
  const [hoveredTurn, setHoveredTurn] = useState<number | null>(null)

  const maxToolCalls = useMemo(
    () => Math.max(1, ...turns.map((t) => t.toolCalls.length)),
    [turns]
  )

  if (turns.length === 0) return null

  const segW = Math.max(2, Math.min(20, SVG_WIDTH / turns.length))
  const totalW = segW * turns.length

  return (
    <section>
      <SectionHeading>Activity Heatmap</SectionHeading>
      <div className="relative">
        <svg width="100%" viewBox={`0 0 ${Math.max(SVG_WIDTH, totalW)} ${SVG_HEIGHT}`}>
          {turns.map((t, i) => {
            const intensity = t.toolCalls.length / maxToolCalls
            const alpha = 0.1 + intensity * 0.9
            return (
              <rect
                key={i}
                x={i * segW}
                y={0}
                width={segW - 1}
                height={SVG_HEIGHT}
                rx={2}
                fill="#60a5fa"
                opacity={alpha}
                onMouseEnter={() => setHoveredTurn(i)}
                onMouseLeave={() => setHoveredTurn(null)}
                className="cursor-pointer"
              />
            )
          })}
        </svg>
        {hoveredTurn !== null && (
          <div className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-elevation-2 px-2 py-1 text-[10px] text-foreground depth-low">
            Turn {hoveredTurn + 1}: {turns[hoveredTurn].toolCalls.length} tool calls
          </div>
        )}
      </div>
    </section>
  )
}
