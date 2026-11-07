import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { jsonFetch } from "@/lib/auth"
import { fetchIfChanged } from "@/lib/conditionalFetch"
import { jsonEqual } from "@/lib/jsonEqual"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import type { CrewMember, SessionCrew } from "../../shared/contracts/crew"
import type { PendingInputResponse } from "../../shared/contracts/pendingInput"

/** While a member works or waits on the user. */
export const ACTIVE_POLL_MS = 4_000
/** While every member has settled. */
export const SETTLED_POLL_MS = 15_000

export interface SessionCrewState {
  crew: SessionCrew | null
  error: string | null
  /** Request ids, task ids and session ids being acted on. */
  busy: ReadonlySet<string>
  respond: (sessionId: string, requestId: string, response: PendingInputResponse) => Promise<void>
  markRead: (parentId: string, taskId: string) => Promise<void>
  stop: (member: CrewMember) => Promise<void>
}

const isBusy = (member: CrewMember) => member.outcome === "running" || member.outcome === "needs_input" || member.status === "deferred"

/**
 * The next crew, reusing every member object that did not change, and the
 * current crew itself when nothing did, so memoized rows keep their identity.
 */
export function shareCrew(current: SessionCrew | null, next: SessionCrew): SessionCrew {
  if (!current) return next
  const previous = new Map(current.members.map((member) => [member.sessionId, member]))
  let same = current.sessionId === next.sessionId && current.rootId === next.rootId && current.members.length === next.members.length
  const members = next.members.map((member, index) => {
    const old = previous.get(member.sessionId)
    const kept = old && jsonEqual(old, member) ? old : member
    if (kept !== current.members[index]) same = false
    return kept
  })
  return same ? current : { ...next, members }
}

/**
 * The crew a session belongs to, kept current while the tab is visible, with
 * the actions the Crew panel takes on its members. It is read every few
 * seconds while a member works or waits on the user and less often once all
 * have settled, and again right after an action. Moving to another session
 * of the same crew keeps the crew on screen while the next read runs.
 */
export function useSessionCrew(sessionId: string | null): SessionCrewState {
  const [crew, setCrew] = useState<SessionCrew | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const refreshList = useSessionInventoryOptional()?.refresh
  const currentSession = useRef(sessionId)
  const inFlight = useRef(new Set<string>())
  const etag = useRef<string | null>(null)
  const latestRequest = useRef(0)
  const crewBusy = useRef(true)
  useLayoutEffect(() => {
    currentSession.current = sessionId
    return () => { currentSession.current = null }
  }, [sessionId])

  const poll = useCallback(async (isActive: () => boolean) => {
    if (!sessionId) return
    const request = ++latestRequest.current
    const current = () => isActive() && request === latestRequest.current
    try {
      const result = await fetchIfChanged<SessionCrew>(`/api/session-crew/${encodeURIComponent(sessionId)}?brief=1`, etag.current)
      if (!current()) return
      if (result.kind === "failed") {
        setError(result.status === 404 ? "This session is no longer available." : "Couldn't load the crew.")
        return
      }
      if (result.kind === "changed") {
        etag.current = result.etag
        crewBusy.current = result.value.members.some(isBusy)
        setCrew((previous) => shareCrew(previous, result.value))
      }
      setError(null)
    } catch {
      if (current()) setError("Couldn't load the crew.")
    }
  }, [sessionId])

  useEffect(() => {
    setCrew((current) => (current?.members.some((member) => member.sessionId === sessionId) ? current : null))
    setError(null)
    setBusy(new Set())
    etag.current = null
    crewBusy.current = true
    if (!sessionId) return
    let active = true
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = () => {
      clearTimeout(timer)
      if (!active || running || document.visibilityState !== "visible") return
      running = true
      void poll(() => active).finally(() => {
        running = false
        if (active) timer = setTimeout(run, crewBusy.current ? ACTIVE_POLL_MS : SETTLED_POLL_MS)
      })
    }
    run()
    document.addEventListener("visibilitychange", run)
    return () => {
      active = false
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", run)
    }
  }, [poll, sessionId])

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
      : jsonFetch("/api/stop-session", { sessionId: member.sessionId, cancelQueued: true })),
    "Couldn't stop the session.",
  ), [act])

  return { crew, error, busy, respond, markRead, stop }
}
