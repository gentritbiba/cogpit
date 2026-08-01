/**
 * Every pending permission request, across every session.
 *
 * A blocked agent is stopped dead, so this is the highest-value signal in the
 * app — the sidebar strip, the header badge and the Mission Control grid all
 * need it, and all three would otherwise disagree. The endpoint reads in-memory
 * provider registries only (no filesystem, no `ps`), so polling it app-wide is
 * far cheaper than the session inventory.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { authFetch } from "@/lib/auth"
import { respondToPermission, type PermissionDecision } from "@/lib/permissionApi"
import { getToolSummary } from "../../shared/session/toolSummary"
import type { MissionControlPermission } from "../../shared/contracts/missionControl"

const POLL_INTERVAL = 3_000

interface RawPermission {
  requestId: string
  toolName: string
  input?: Record<string, unknown>
  title?: string
  description?: string
  availableDecisions?: PermissionDecision[]
  timestamp: number
}

export interface PendingPermissions {
  bySession: Map<string, MissionControlPermission[]>
  /** Session ids with at least one live request. */
  awaiting: Set<string>
  /** Request ids currently being answered. */
  responding: Set<string>
  respond: (
    sessionId: string,
    requestId: string,
    behavior: PermissionDecision,
  ) => Promise<void>
  refresh: () => void
}

const PendingPermissionsContext = createContext<PendingPermissions | null>(null)

export function PendingPermissionsProvider({ children }: { children: ReactNode }) {
  const [bySession, setBySession] = useState<Map<string, MissionControlPermission[]>>(new Map)
  const [responding, setResponding] = useState<Set<string>>(new Set())
  const cancelledRef = useRef(false)
  // Identical polls must not produce a new Map, or every consumer re-renders
  // every few seconds forever.
  const lastRawRef = useRef<string>("")

  useEffect(() => {
    cancelledRef.current = false
    return () => { cancelledRef.current = true }
  }, [])

  const fetchNow = useCallback(async () => {
    try {
      const res = await authFetch("/api/permissions")
      if (cancelledRef.current || !res.ok) return
      const text = await res.text()
      if (cancelledRef.current || text === lastRawRef.current) return
      lastRawRef.current = text

      const data = JSON.parse(text) as { bySession?: Record<string, RawPermission[]> }
      const next = new Map<string, MissionControlPermission[]>()
      for (const [sessionId, requests] of Object.entries(data.bySession ?? {})) {
        next.set(sessionId, requests.map((r) => ({
          sessionId,
          requestId: r.requestId,
          toolName: r.toolName,
          summary: getToolSummary({ name: r.toolName, input: r.input ?? {} }),
          title: r.title,
          description: r.description,
          ...(r.availableDecisions && { availableDecisions: r.availableDecisions }),
          timestamp: r.timestamp,
        })))
      }
      setBySession(next)
    } catch {
      // Transient failures resolve on the next poll; a stale list is better
      // than dropping a request the user still has to answer.
    }
  }, [])

  useEffect(() => {
    const pollWhenVisible = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void fetchNow()
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") void fetchNow()
    }

    pollWhenVisible()
    const id = setInterval(pollWhenVisible, POLL_INTERVAL)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [fetchNow])

  const respond = useCallback(async (
    sessionId: string,
    requestId: string,
    behavior: PermissionDecision,
  ) => {
    setResponding((prev) => new Set(prev).add(requestId))
    try {
      if (await respondToPermission(sessionId, requestId, behavior)) {
        // Release the card immediately rather than waiting out the poll.
        setBySession((prev) => {
          const next = new Map(prev)
          const remaining = (next.get(sessionId) ?? []).filter((p) => p.requestId !== requestId)
          if (remaining.length > 0) next.set(sessionId, remaining)
          else next.delete(sessionId)
          return next
        })
        lastRawRef.current = ""
      }
    } catch {
      // The next poll re-surfaces the request if the answer did not land.
    } finally {
      setResponding((prev) => {
        const next = new Set(prev)
        next.delete(requestId)
        return next
      })
      void fetchNow()
    }
  }, [fetchNow])

  const awaiting = useMemo(() => new Set(bySession.keys()), [bySession])
  const refresh = useCallback(() => { void fetchNow() }, [fetchNow])

  const value = useMemo<PendingPermissions>(
    () => ({ bySession, awaiting, responding, respond, refresh }),
    [bySession, awaiting, responding, respond, refresh],
  )

  return (
    <PendingPermissionsContext.Provider value={value}>
      {children}
    </PendingPermissionsContext.Provider>
  )
}

export function usePendingPermissions(): PendingPermissions {
  const ctx = useContext(PendingPermissionsContext)
  if (!ctx) {
    throw new Error("usePendingPermissions must be used within a PendingPermissionsProvider")
  }
  return ctx
}
