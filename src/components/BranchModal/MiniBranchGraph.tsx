import { BRANCH_COLORS, BRANCH_INNER } from "./branchStyles"
import type { DisplayBranch } from "./index"

export function MiniBranchGraph({
  branches,
  activeBranchIdx,
  branchPointTurnIndex,
}: {
  branches: DisplayBranch[]
  activeBranchIdx: number
  branchPointTurnIndex: number
}) {
  const numBranches = branches.length
  if (numBranches === 0) return null

  const sharedCount = Math.min(branchPointTurnIndex + 1, 5)
  const maxBranchTurns = Math.max(...branches.map((b) => b.graphTurnCount), 1)
  const cappedMax = Math.min(maxBranchTurns, 6)

  const ss = 25
  const bpX = 20 + sharedCount * ss
  const ns = Math.min(32, Math.max(20, (300 - bpX) / (cappedMax + 1)))

  const branchGap = 27
  const firstY = 18
  const height = firstY + (numBranches - 1) * branchGap + 15

  return (
    <div className="rounded-lg border border-border bg-elevation-1 px-3 py-2">
      <svg width="100%" height={height} viewBox={`0 0 340 ${height}`}>
        {/* Shared trunk */}
        <line x1={20} y1={firstY} x2={bpX} y2={firstY} stroke="#3b82f6" strokeWidth={2} />
        {Array.from({ length: sharedCount }).map((_, i) => (
          <g key={`s-${i}`}>
            <circle cx={20 + i * ss} cy={firstY} r={3.5} fill="var(--background)" stroke="#3b82f6" strokeWidth={1.5} />
            <circle cx={20 + i * ss} cy={firstY} r={1.5} fill="#60a5fa" />
          </g>
        ))}
        {/* Branch point */}
        <circle cx={bpX} cy={firstY} r={5} fill="var(--background)" stroke="#a855f7" strokeWidth={2} />
        <circle cx={bpX} cy={firstY} r={2} fill="#c084fc" />

        {/* Branches */}
        {branches.map((branch, bi) => {
          const isActive = bi === activeBranchIdx
          const ci = bi % BRANCH_COLORS.length
          const color = isActive ? BRANCH_COLORS[ci] : "var(--muted)"
          const inner = isActive ? BRANCH_INNER[ci] : "var(--border)"
          const y = firstY + bi * branchGap
          const count = Math.min(branch.graphTurnCount, cappedMax)

          return (
            <g
              key={branch.id}
              className="transition-opacity duration-500"
              style={{ opacity: isActive ? 1 : 0.3 }}
            >
              {bi === 0 ? (
                <line x1={bpX} y1={y} x2={bpX + count * ns} y2={y} stroke={color} strokeWidth={2} />
              ) : (
                <>
                  <path
                    d={`M ${bpX} ${firstY} C ${bpX + 10} ${y - 5}, ${bpX + 20} ${y}, ${bpX + ns} ${y}`}
                    fill="none" stroke={color} strokeWidth={2}
                  />
                  {count > 1 && (
                    <line x1={bpX + ns} y1={y} x2={bpX + count * ns} y2={y} stroke={color} strokeWidth={2} />
                  )}
                </>
              )}
              {Array.from({ length: count }).map((_, ni) => (
                <g key={ni}>
                  <circle cx={bpX + (ni + 1) * ns} cy={y} r={3.5} fill="var(--background)" stroke={color} strokeWidth={1.5} />
                  <circle cx={bpX + (ni + 1) * ns} cy={y} r={1.5} fill={inner} />
                </g>
              ))}
              {branch.graphTurnCount > cappedMax && (
                <text
                  x={bpX + (count + 0.4) * ns} y={y + 3}
                  fill={isActive ? BRANCH_COLORS[ci] : "var(--border)"}
                  fontSize="8" fontFamily="monospace"
                >
                  +{branch.graphTurnCount - cappedMax}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
