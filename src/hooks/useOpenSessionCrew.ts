import { useMemo } from "react"
import { countCrew, memberStatus, NO_PENDING_INPUT, type CrewPendingInput } from "@/components/LiveSessions/crew"
import { usePendingHumanInputOptional } from "@/contexts/PendingHumanInputContext"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { useDelegatedTasks } from "@/hooks/useDelegatedTasks"
import type { OpenSessionCrew } from "@/plugin-api"

/**
 * The crew the open session belongs to: its root and how many members wait
 * or work, as the session list knows it, or from the tasks the session handed
 * out when its members are not listed here (they run on another machine, or
 * are too old for the list). Null for a session in no crew, so the Crew
 * panel stays off the rail.
 */
export function useOpenSessionCrew(sessionId: string | null): OpenSessionCrew | null {
  const inventory = useSessionInventoryOptional()
  const pending = usePendingHumanInputOptional()
  const tasks = useDelegatedTasks(sessionId)
  const sessions = inventory?.sessions
  const procBySession = inventory?.procBySession
  const pendingSets = useMemo<CrewPendingInput>(() => (pending
    ? {
        awaitingPermission: pending.awaitingPermission,
        awaitingQuestion: pending.awaitingQuestion,
        awaitingPrompt: new Set([...pending.awaitingElicitation, ...pending.awaitingDialog]),
        awaitingPlan: pending.awaitingPlan,
      }
    : NO_PENDING_INPUT), [pending])

  return useMemo(() => {
    if (!sessionId || !sessions || !procBySession) return null
    const own = sessions.find((session) => session.sessionId === sessionId)
    const rootId = own?.crew?.rootId ?? sessionId
    const members = sessions.filter((session) => session.crew?.rootId === rootId)
    if (members.length === 0) {
      if (tasks.length === 0) return null
      return { rootId, size: tasks.length, needsYou: 0, working: tasks.filter((task) => task.state === "running").length }
    }
    const counts = countCrew(members, (member) => memberStatus(member, procBySession, pendingSets))
    return { rootId, size: counts.size, needsYou: counts.needsYou, working: counts.working }
  }, [sessionId, sessions, procBySession, pendingSets, tasks])
}
