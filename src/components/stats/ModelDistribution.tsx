import { useMemo } from "react"
import { SectionHeading } from "@/components/stats/SectionHeading"
import type { Turn } from "@/lib/types"

export function ModelDistribution({ turns }: { turns: Turn[] }): JSX.Element | null {
  const models = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of turns) {
      if (t.model) {
        counts[t.model] = (counts[t.model] ?? 0) + 1
      }
    }
    return Object.entries(counts).sort(([, a], [, b]) => b - a)
  }, [turns])

  if (models.length <= 1) return null

  return (
    <section>
      <SectionHeading>Models</SectionHeading>
      <div className="space-y-1">
        {models.map(([model, count]) => (
          <div
            key={model}
            className="flex items-center justify-between rounded border border-border elevation-2 depth-low px-2.5 py-1.5 text-[11px]"
          >
            <span className="truncate text-foreground">{model}</span>
            <span className="ml-2 shrink-0 text-muted-foreground">{count}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
