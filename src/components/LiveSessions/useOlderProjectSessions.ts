import { useCallback, useState } from "react"
import { toast } from "sonner"

import { authFetch } from "@/lib/auth"

import type { ProjectScopeOption } from "./projectScope"
import type { ActiveSessionInfo } from "./types"

interface OlderState {
  key: string | null
  sessions: ActiveSessionInfo[]
  loading: boolean
  loaded: boolean
}

const EMPTY: OlderState = { key: null, sessions: [], loading: false, loaded: false }

/**
 * The inventory lists only a project's newest sessions. A focused project can
 * ask for the rest once; the answer is dropped as soon as the focused project
 * or the archived toggle changes, so it never leaks into another view.
 */
export function useOlderProjectSessions(project: ProjectScopeOption | null, includeArchived: boolean) {
  const key = project ? `${includeArchived ? "a" : "l"}:${project.key}` : null
  const dirNames = project?.dirNames
  const [state, setState] = useState<OlderState>(EMPTY)
  const current = state.key === key ? state : EMPTY

  const load = useCallback(async () => {
    if (key === null || !dirNames?.length) return
    setState({ key, sessions: [], loading: true, loaded: false })
    try {
      const lists = await Promise.all(dirNames.map(async (dirName) => {
        const params = new URLSearchParams({ project: dirName, limit: "200" })
        if (includeArchived) params.set("archived", "include")
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
  }, [key, dirNames, includeArchived])

  return { sessions: current.sessions, loading: current.loading, loaded: current.loaded, load }
}
