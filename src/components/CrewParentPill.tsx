import { useMemo } from "react"
import { ArrowUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FLOATING_PILL } from "@/components/header-shared"
import { crewSessionTitle } from "@/components/LiveSessions/crew"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { useSessionNames } from "@/hooks/useSessionNames"
import { revealSessionById, revealSessionPath, sessionPath } from "@/lib/revealSession"
import { cn } from "@/lib/utils"

/**
 * For a session another session started through Cogpit: who it reports to,
 * beside its own pill, opening that session on click. Renders nothing for a
 * session nothing started.
 */
export function CrewParentPill({ sessionId }: { sessionId: string }) {
  const inventory = useSessionInventoryOptional()
  const { names } = useSessionNames()
  const knownById = useMemo(
    () => new Map((inventory?.sessions ?? []).map((session) => [session.sessionId, session])),
    [inventory?.sessions],
  )
  const crew = knownById.get(sessionId)?.crew
  if (!crew) return null

  const parent = knownById.get(crew.parentId)
  const title = crewSessionTitle(crew.parentId, knownById, names) ?? crew.parentTitle ?? "the session that started it"
  const open = () => {
    if (parent) revealSessionPath(sessionPath(parent.dirName, parent.fileName))
    else void revealSessionById(crew.parentId)
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-crew-parent
      onClick={open}
      aria-label={`Reports to ${title}`}
      title={`Open ${title}, which started this session`}
      className={cn(
        FLOATING_PILL,
        // Gives way before the session's own pill: capped, and quicker to shrink.
        "h-8 min-w-12 max-w-56 shrink-[4] gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground",
      )}
    >
      <ArrowUp className="size-3 shrink-0" aria-hidden="true" />
      <span className="shrink-0 max-[1200px]:hidden">Reports to</span>
      <span className="truncate font-medium text-foreground">{title}</span>
    </Button>
  )
}
