import { ChevronRight, Network } from "lucide-react"
import type { DelegatedTask } from "../../shared/contracts/orchestration"
import { Button } from "@/components/ui/button"
import { useDelegatedTasks } from "@/hooks/useDelegatedTasks"

function summary(tasks: readonly DelegatedTask[]): string {
  const running = tasks.filter((task) => task.state === "running").length
  const finished = tasks.length - running
  return [running && `${running} running`, finished && `${finished} finished`].filter(Boolean).join(" · ")
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
  const tasks = useDelegatedTasks(sessionId)
  const visible = tasks.filter((task) => !task.acknowledgedAt && task.state !== "cancelled")
  if (crewOpen || !visible.length) return null
  const running = visible.some((task) => task.state === "running")

  return (
    <div role="status" aria-label="Sessions this one started" className="mx-3 flex items-center gap-2 rounded-xl border border-border bg-card/60 py-1 pl-3 pr-1 text-sm">
      <Network className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {running && <span className="size-1.5 shrink-0 rounded-full bg-success ring-2 ring-success/30" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        <span className="text-foreground">Crew</span> · {summary(visible)}
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
