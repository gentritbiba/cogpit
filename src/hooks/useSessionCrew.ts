import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { authFetch, jsonFetch } from "@/lib/auth"
import { useVisiblePolling } from "@/hooks/useVisiblePolling"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import type { CrewMember, SessionCrew } from "../../shared/contracts/crew"
import type { PendingInputResponse } from "../../shared/contracts/pendingInput"

const POLL_INTERVAL = 4_000

export interface SessionCrewState {
  crew: SessionCrew | null
  error: string | null
  /** Request ids, task ids and session ids being acted on. */
  busy: ReadonlySet<string>
  respond: (sessionId: string, requestId: string, response: PendingInputResponse) => Promise<void>
  markRead: (parentId: string, taskId: string) => Promise<void>
  stop: (member: CrewMember) => Promise<void>
}

/**
 * The crew a session belongs to, kept current while the tab is visible, with
 * the actions the Crew panel takes on its members. Moving to another session
 * of the same crew keeps the crew on screen while the next read runs.
 */
export function useSessionCrew(sessionId: string | null): SessionCrewState {
  const [crew, setCrew] = useState<SessionCrew | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const refreshList = useSessionInventoryOptional()?.refresh
  const currentSession = useRef(sessionId)
  const inFlight = useRef(new Set<string>())
  useLayoutEffect(() => {
    currentSession.current = sessionId
    return () => { currentSession.current = null }
  }, [sessionId])

  const poll = useCallback(async (isActive: () => boolean) => {
    if (!sessionId) return
    try {
      const response = await authFetch(`/api/session-crew/${encodeURIComponent(sessionId)}`)
      if (!isActive()) return
      if (!response.ok) {
        setError(response.status === 404 ? "This session is no longer available." : "Couldn't load the crew.")
        return
      }
      const next = await response.json() as SessionCrew
      if (!isActive()) return
      setCrew((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next))
      setError(null)
    } catch {
      if (isActive()) setError("Couldn't load the crew.")
    }
  }, [sessionId])
  useVisiblePolling(sessionId ? poll : null, POLL_INTERVAL)

  useEffect(() => {
    setCrew((current) => (current?.members.some((member) => member.sessionId === sessionId) ? current : null))
    setError(null)
    setBusy(new Set())
  }, [sessionId])

  const act = useCallback(async (key: string, request: () => Promise<Response>, failure: string) => {
    const actionKey = `${sessionId}:${key}`
    if (inFlight.current.has(actionKey)) return
    const isCurrent = () => currentSession.current === sessionId
    inFlight.current.add(actionKey)
    setBusy((current) => new Set(current).add(key))
    try {
      const response = await request()
      if (!isCurrent()) return
      if (!response.ok && response.status !== 404) {
        setError(failure)
        return
      }
      // The session list shows the same crew; it should not lag the panel.
      refreshList?.()
      await poll(isCurrent)
    } catch {
      if (isCurrent()) setError(failure)
    } finally {
      inFlight.current.delete(actionKey)
      if (isCurrent()) {
        setBusy((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      }
    }
  }, [poll, refreshList, sessionId])

  const respond = useCallback((memberId: string, requestId: string, response: PendingInputResponse) => act(
    requestId,
    () => jsonFetch("/api/session-respond", { sessionId: memberId, requestId, ...response }),
    "Couldn't send the answer.",
  ), [act])
  const markRead = useCallback((parentId: string, taskId: string) => act(
    taskId,
    () => jsonFetch("/api/delegated-tasks", { sessionId: parentId, taskId, action: "ack" }),
    "Couldn't mark the result read.",
  ), [act])
  // A running delegated task cancels on whichever machine the member runs;
  // a member with none can only be stopped here.
  const stop = useCallback((member: CrewMember) => act(
    member.sessionId,
    () => (member.result?.state === "running" && member.parentId
      ? jsonFetch("/api/delegated-tasks", { sessionId: member.parentId, taskId: member.result.taskId, action: "cancel" })
      : jsonFetch("/api/stop-session", { sessionId: member.sessionId })),
    "Couldn't stop the session.",
  ), [act])

  return { crew, error, busy, respond, markRead, stop }
}
