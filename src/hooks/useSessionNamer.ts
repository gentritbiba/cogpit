import { useCallback, useMemo } from "react"
import { crewSessionTitle } from "@/components/LiveSessions/crew"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { useSessionNames } from "@/hooks/useSessionNames"

/**
 * Names a listed session the way the session list and its crews do: the
 * user's name, the name it was started with, its title. Undefined for a
 * session the list does not carry.
 */
export function useSessionNamer(): (sessionId: string) => string | undefined {
  const inventory = useSessionInventoryOptional()
  const { names } = useSessionNames()
  const knownById = useMemo(
    () => new Map((inventory?.sessions ?? []).map((session) => [session.sessionId, session])),
    [inventory?.sessions],
  )
  return useCallback((sessionId: string) => crewSessionTitle(sessionId, knownById, names), [knownById, names])
}
