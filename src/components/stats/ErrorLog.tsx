import { useMemo } from "react"
import { SectionHeading } from "@/components/stats/SectionHeading"
import type { Turn } from "../../../shared/session/types"
import { Button } from "@/components/ui/button"

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

export function ErrorLog({ turns, onJumpToTurn }: ErrorLogProps): React.JSX.Element | null {
  const errors = useMemo(() => collectErrors(turns), [turns])

  if (errors.length === 0) return null

  return (
    <section>
      <SectionHeading>Errors ({errors.length})</SectionHeading>
      <div className="flex max-h-[300px] flex-col overflow-y-auto pr-1">
        {errors.map((err, i) => (
          <Button
            key={i}
            type="button"
            variant="ghost"
            onClick={() => onJumpToTurn?.(err.turnIndex)}
            className="h-auto w-full flex-col items-stretch rounded-none border-b border-border px-2 py-2.5 text-left whitespace-normal last:border-b-0 hover:bg-destructive/5"
          >
            <div className="flex items-center gap-1.5 text-xs">
              <span className="font-medium text-destructive">{err.toolName}</span>
              <span className="text-muted-foreground">Turn {err.turnIndex + 1}</span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {err.message}
            </div>
          </Button>
        ))}
      </div>
    </section>
  )
}
