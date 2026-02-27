import { useMemo } from "react"
import { SectionHeading } from "@/components/stats/SectionHeading"
import type { Turn } from "@/lib/types"

interface ErrorEntry {
  turnIndex: number
  toolName: string
  message: string
}

function collectErrors(turns: Turn[]): ErrorEntry[] {
  const result: ErrorEntry[] = []
  for (let i = 0; i < turns.length; i++) {
    for (const tc of turns[i].toolCalls) {
      if (tc.isError && tc.result) {
        result.push({
          turnIndex: i,
          toolName: tc.name,
          message: tc.result.slice(0, 200),
        })
      }
    }
  }
  return result
}

interface ErrorLogProps {
  turns: Turn[]
  onJumpToTurn?: (turnIndex: number, toolCallId?: string) => void
}

export function ErrorLog({ turns, onJumpToTurn }: ErrorLogProps): JSX.Element | null {
  const errors = useMemo(() => collectErrors(turns), [turns])

  if (errors.length === 0) return null

  return (
    <section>
      <SectionHeading>Errors ({errors.length})</SectionHeading>
      <div className="max-h-[300px] overflow-y-auto space-y-1.5 pr-1">
        {errors.map((err, i) => (
          <button
            key={i}
            onClick={() => onJumpToTurn?.(err.turnIndex)}
            className="w-full rounded-lg border border-red-900/40 bg-red-950/20 depth-low px-3 py-2.5 text-left transition-colors hover:bg-red-950/40 hover:border-red-800/40"
          >
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="font-medium text-red-400">{err.toolName}</span>
              <span className="text-muted-foreground">Turn {err.turnIndex + 1}</span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground">
              {err.message}
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}
