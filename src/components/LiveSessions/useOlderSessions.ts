import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { authFetch } from "@/lib/auth"
import { activeSessionsUrl, type ListFilter } from "@/lib/sessionListFilter"
import { learnListedAccess, onListsStale, sessionAccessTicket } from "@/lib/sessionAccess"

import type { ActiveSessionInfo } from "./types"

/** What to load more of: every project, or the directories behind one of them. */
export interface OlderSessionsTarget {
  key: string
  dirNames?: readonly string[]
}

interface OlderState {
  key: string | null
  sessions: ActiveSessionInfo[]
  loading: boolean
  loaded: boolean
}

const EMPTY: OlderState = { key: null, sessions: [], loading: false, loaded: false }

function queriesFor(target: OlderSessionsTarget, includeArchived: boolean): URLSearchParams[] {
  const queries = target.dirNames
    ? target.dirNames.map((dirName) => new URLSearchParams({ project: dirName, limit: "200" }))
    : [new URLSearchParams({ limit: "200", perProject: "100" })]
  if (includeArchived) for (const query of queries) query.set("archived", "include")
  return queries
}

/**
 * The inventory lists only the newest sessions. The list can ask for the rest
 * once; the answer is dropped as soon as the target, the archived toggle or the
 * list filter changes, so it never leaks into another view, and read again when
 * the lists go stale.
 */
export function useOlderSessions(
  target: OlderSessionsTarget | null,
  includeArchived: boolean,
  filter: ListFilter,
) {
  const key = target ? `${includeArchived ? "a" : "l"}:${filter.key ?? ""}:${target.key}` : null
  const [state, setState] = useState<OlderState>(EMPTY)
  const current = state.key === key ? state : EMPTY

  const load = useCallback(async () => {
    if (key === null || !target) return
    // Reading the same target again keeps its list up until the answer lands.
    setState((prev) => (prev.key === key ? { ...prev, loading: true } : { key, sessions: [], loading: true, loaded: false }))
    const accessTicket = sessionAccessTicket()
    try {
      const lists = await Promise.all(queriesFor(target, includeArchived).map(async (params) => {
        const response = await authFetch(activeSessionsUrl(params, filter))
        if (!response.ok) throw new Error(`Could not load older sessions (${response.status})`)
        const body: unknown = await response.json()
        return Array.isArray(body) ? body as ActiveSessionInfo[] : []
      }))
      const sessions = lists.flat()
      learnListedAccess(sessions, accessTicket)
      setState((prev) => (prev.key === key ? { key, sessions, loading: false, loaded: true } : prev))
    } catch (err) {
      setState((prev) => (prev.key === key ? { ...prev, loading: false } : prev))
      toast.error(err instanceof Error ? err.message : "Could not load older sessions")
    }
  }, [key, target, includeArchived, filter])

  const { loaded } = current
  useEffect(() => {
    if (!loaded) return
    return onListsStale(() => void load())
  }, [loaded, load])

  return { sessions: current.sessions, loading: current.loading, loaded, load }
}
