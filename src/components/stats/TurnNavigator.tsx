import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { SectionHeading } from "@/components/stats/SectionHeading"
import type { Turn } from "@/lib/types"
import { truncate } from "@/lib/format"
import { getUserMessageText } from "@/lib/parser"

interface TurnNavigatorProps {
  turns: Turn[]
  onJumpToTurn?: (turnIndex: number, toolCallId?: string) => void
}

export function TurnNavigator({ turns, onJumpToTurn }: TurnNavigatorProps): JSX.Element | null {
  const [activeTurn, setActiveTurn] = useState<number | null>(null)

  if (turns.length === 0) return null

  return (
    <section>
      <SectionHeading>Turns ({turns.length})</SectionHeading>
      <div className="max-h-[400px] overflow-y-auto">
        <div className="flex flex-col gap-0.5 pr-2">
          {turns.map((turn, i) => {
            const preview = getUserMessageText(turn.userMessage)
            const isActive = activeTurn === i
            return (
              <button
                key={turn.id}
                onClick={() => {
                  setActiveTurn(i)
                  onJumpToTurn?.(i)
                }}
                className={cn(
                  "group flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                  isActive
                    ? "bg-elevation-2 text-foreground"
                    : "text-muted-foreground hover:bg-elevation-1 hover:text-foreground"
                )}
              >
                <span className="mt-0.5 shrink-0 text-[10px] font-mono text-muted-foreground">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">
                  {preview ? truncate(preview, 50) : "(no message)"}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {turn.toolCalls.length > 0 && (
                    <Badge
                      variant="secondary"
                      className="h-4 px-1 text-[10px] font-normal"
                    >
                      {turn.toolCalls.length}
                    </Badge>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
