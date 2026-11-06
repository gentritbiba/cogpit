import { useCallback, useEffect, useState } from "react"
import { authFetch, jsonFetch } from "@/lib/auth"
import { readError } from "@/lib/httpJson"
import { useVisiblePolling } from "@/hooks/useVisiblePolling"
import { VIEWS_PATH, type ViewSummary, type ViewUpdate } from "../../../shared/views/stored"
import { announceViewsChanged, onViewsChanged, rememberNewestVersions, viewsScope } from "@/components/timeline/cogpit-blocks/view/storedView"

/** Views change rarely and only when an agent builds one, so a light poll keeps a shown list fresh. */
const POLL_INTERVAL = 30_000
function viewPath(id: string): string {
  return `${VIEWS_PATH}/${encodeURIComponent(id)}`
}

/** Pinned views first, then the most recently updated. */
export function sortViews(views: readonly ViewSummary[]): ViewSummary[] {
  return [...views].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
}

interface ViewsState {
  /** Null until the first answer. */
  views: ViewSummary[] | null
  error: string | null
}

/**
 * The stored views on the active device the caller may see, kept current
 * while shown: loaded on mount, every 30 seconds and whenever the tab becomes
 * visible, and again after any list changes one. Changes answer an error to
 * show, or null.
 */
export function useViews() {
  const [state, setState] = useState<ViewsState>({ views: null, error: null })
  const [reloads, setReloads] = useState(0)

  const load = useCallback(async (isActive: () => boolean) => {
    const scope = viewsScope()
    try {
      const response = await authFetch(VIEWS_PATH)
      if (!isActive()) return
      if (!response.ok) {
        const error = await readError(response, "Could not load views")
        if (isActive()) setState((current) => ({ ...current, error }))
        return
      }
      const { views } = await response.json() as { views: ViewSummary[] }
      rememberNewestVersions(scope, views)
      if (isActive()) setState({ views, error: null })
    } catch {
      if (isActive()) setState((current) => ({ ...current, error: "Could not load views" }))
    }
  }, [])
  useVisiblePolling(load, POLL_INTERVAL)

  useEffect(() => {
    if (reloads === 0) return
    let active = true
    void load(() => active)
    return () => { active = false }
  }, [reloads, load])

  const refresh = useCallback(() => setReloads((count) => count + 1), [])

  useEffect(() => onViewsChanged(refresh), [refresh])

  const update = useCallback(async (id: string, change: ViewUpdate): Promise<string | null> => {
    try {
      const response = await jsonFetch(viewPath(id), change, { method: "PATCH" })
      if (!response.ok) return await readError(response, "Could not change the view")
      const updated = await response.json() as ViewSummary
      setState((current) => ({ ...current, views: current.views?.map((view) => (view.id === id ? updated : view)) ?? null }))
      announceViewsChanged()
      return null
    } catch {
      return "Could not change the view"
    }
  }, [])

  const remove = useCallback(async (id: string): Promise<string | null> => {
    try {
      const response = await authFetch(viewPath(id), { method: "DELETE" })
      if (!response.ok) return await readError(response, "Could not delete the view")
      setState((current) => ({ ...current, views: current.views?.filter((view) => view.id !== id) ?? null }))
      announceViewsChanged()
      return null
    } catch {
      return "Could not delete the view"
    }
  }, [])

  return { views: state.views, error: state.error, refresh, update, remove }
}
