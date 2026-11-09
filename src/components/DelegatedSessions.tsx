import { ChevronRight, Network } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useDelegatedTaskCounts } from "@/hooks/useDelegatedTaskCounts"
import type { DelegatedTaskCounts } from "../../shared/contracts/orchestration"

function summary({ unread, unreadRunning }: DelegatedTaskCounts): string {
  const finished = unread - unreadRunning
  return [unreadRunning && `${unreadRunning} running`, finished && `${finished} finished`].filter(Boolean).join(" · ")
}

/**
 * One line above the composer while sessions this one started are working
 * or have results it has not read; the Crew panel holds the rest. Renders
 * nothing while the panel is open or there is nothing to say.
 */
export function DelegatedSessions({
  sessionId,
  crewOpen = false,
  onOpenCrew,
}: {
  sessionId: string
  crewOpen?: boolean
  onOpenCrew?: () => void
}) {
  const counts = useDelegatedTaskCounts(sessionId)
  if (crewOpen || counts.unread === 0) return null
  const running = counts.unreadRunning > 0

  return (
    <div role="status" aria-label="Sessions this one started" className="mx-3 flex items-center gap-2 rounded-xl border border-border bg-card/60 py-1 pl-3 pr-1 text-sm">
      <Network className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {running && <span className="size-1.5 shrink-0 rounded-full bg-success ring-2 ring-success/30" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        <span className="text-foreground">Crew</span> · {summary(counts)}
      </span>
      {onOpenCrew && (
        <Button variant="ghost" size="xs" onClick={onOpenCrew}>
          Open crew
          <ChevronRight data-icon="inline-end" />
        </Button>
      )}
    </div>
  )
}
