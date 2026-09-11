import { useCallback, useState } from "react"
import { toast } from "sonner"

import { authFetch } from "@/lib/auth"

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
 * once; the answer is dropped as soon as the target or the archived toggle
 * changes, so it never leaks into another view.
 */
export function useOlderSessions(target: OlderSessionsTarget | null, includeArchived: boolean) {
  const key = target ? `${includeArchived ? "a" : "l"}:${target.key}` : null
  const [state, setState] = useState<OlderState>(EMPTY)
  const current = state.key === key ? state : EMPTY

  const load = useCallback(async () => {
    if (key === null || !target) return
    setState({ key, sessions: [], loading: true, loaded: false })
    try {
      const lists = await Promise.all(queriesFor(target, includeArchived).map(async (params) => {
        const response = await authFetch(`/api/active-sessions?${params}`)
        if (!response.ok) throw new Error(`Could not load older sessions (${response.status})`)
        const body: unknown = await response.json()
        return Array.isArray(body) ? body as ActiveSessionInfo[] : []
      }))
      setState((prev) => (prev.key === key ? { key, sessions: lists.flat(), loading: false, loaded: true } : prev))
    } catch (err) {
      setState((prev) => (prev.key === key ? { ...prev, loading: false } : prev))
      toast.error(err instanceof Error ? err.message : "Could not load older sessions")
    }
  }, [key, target, includeArchived])

  return { sessions: current.sessions, loading: current.loading, loaded: current.loaded, load }
}
