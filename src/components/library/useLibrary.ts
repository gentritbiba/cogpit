import { useCallback, useEffect, useRef, useState } from "react"
import { authFetch } from "@/lib/auth"
import { readError } from "@/lib/httpJson"
import { useVisiblePolling } from "@/hooks/useVisiblePolling"
import { LIBRARY_MAX_PAGE, LIBRARY_PAGE, LIBRARY_PATH, type LibraryResponse, type LibraryScope, type LibraryTab } from "../../../shared/library/types"

/** Shared things arrive as the session index reads new replies, so a shown tab looks again this often. */
const POLL_INTERVAL = 20_000

export interface LibraryRequest {
  scope: LibraryScope
  sessionId: string | null
  project: string | null
  /** Null asks only for the counts and view ids. */
  tab: LibraryTab | null
  text: string
}

/** The listing's address without its paging, which also names the request. */
export function libraryUrl(request: LibraryRequest): string {
  const params = new URLSearchParams({ scope: request.scope })
  if (request.tab) params.set("tab", request.tab)
  if (request.scope === "session" && request.sessionId) params.set("session", request.sessionId)
  if (request.scope === "project" && request.project) params.set("project", request.project)
  if (request.text.trim()) params.set("q", request.text.trim())
  return `${LIBRARY_PATH}?${params}`
}

interface LibraryState {
  /** The request the answer is for; another request's answer is never shown. */
  url: string
  data: LibraryResponse | null
  error: string | null
  loadingMore: boolean
}

function emptyState(url: string): LibraryState {
  return { url, data: null, error: null, loadingMore: false }
}

const FAILED = "Could not load the library"
const REMOVE_FAILED = "Could not remove it from the library"

async function fetchPage(url: string): Promise<LibraryResponse | string> {
  try {
    const response = await authFetch(url)
    return response.ok ? await response.json() as LibraryResponse : await readError(response, FAILED)
  } catch {
    return FAILED
  }
}

/** A refresh reloads at most the largest page; pages loaded past it stay as they were. */
function withLaterPages(answer: LibraryResponse, loaded: LibraryResponse | null): LibraryResponse {
  if (!loaded || loaded.items.length <= answer.items.length || !answer.next) return answer
  const ids = new Set(answer.items.map((item) => item.id))
  return {
    ...loaded,
    ...answer,
    items: [...answer.items, ...loaded.items.slice(answer.items.length).filter((item) => !ids.has(item.id))],
    next: loaded.next,
    sessions: { ...loaded.sessions, ...answer.sessions },
  }
}

/**
 * One tab of the library on the active device for a scope, kept current while
 * `active`: loaded then, every 20 seconds while the browser tab is visible and
 * when `refreshKey` changes. `loadMore` appends the next page.
 */
export function useLibrary(request: LibraryRequest, { active = true, refreshKey }: { active?: boolean; refreshKey?: unknown } = {}) {
  const url = libraryUrl(request)
  const [state, setState] = useState<LibraryState>(() => emptyState(url))
  const current = state.url === url ? state : emptyState(url)
  const loaded = useRef(0)
  useEffect(() => { loaded.current = current.data?.items.length ?? 0 })

  const load = useCallback(async (isActive: () => boolean) => {
    const answer = await fetchPage(`${url}&limit=${Math.min(LIBRARY_MAX_PAGE, Math.max(LIBRARY_PAGE, loaded.current))}`)
    if (!isActive()) return
    setState((previous) => {
      const same = previous.url === url
      const shown = same ? previous.data : null
      const loadingMore = same && previous.loadingMore
      if (typeof answer === "string") return { url, data: shown, error: answer, loadingMore }
      return { url, data: withLaterPages(answer, shown), error: null, loadingMore }
    })
  }, [url])
  useVisiblePolling(active ? load : null, POLL_INTERVAL)

  const [reloads, setReloads] = useState(0)
  useEffect(() => {
    if (reloads === 0) return
    let active = true
    void load(() => active)
    return () => { active = false }
  }, [reloads, load])
  const refresh = useCallback(() => setReloads((count) => count + 1), [])
  const firstKey = useRef(refreshKey)
  useEffect(() => {
    if (firstKey.current === refreshKey) return
    firstKey.current = refreshKey
    refresh()
  }, [refreshKey, refresh])

  const next = current.data?.next ?? null
  const loadMore = useCallback(async () => {
    if (!next) return
    setState((previous) => (previous.url === url ? { ...previous, loadingMore: true } : previous))
    const page = await fetchPage(`${url}&limit=${LIBRARY_PAGE}&before=${encodeURIComponent(next)}`)
    setState((previous) => {
      if (previous.url !== url || !previous.data) return previous
      if (typeof page === "string") return { ...previous, loadingMore: false, error: page }
      const seen = new Set(previous.data.items.map((item) => item.id))
      return {
        ...previous,
        loadingMore: false,
        data: {
          ...page,
          items: [...previous.data.items, ...page.items.filter((item) => !seen.has(item.id))],
          sessions: { ...previous.data.sessions, ...page.sessions },
        },
      }
    })
  }, [url, next])

  const remove = useCallback(async (id: number): Promise<string | null> => {
    try {
      const response = await authFetch(`${LIBRARY_PATH}/items/${id}`, { method: "DELETE" })
      if (!response.ok) return await readError(response, REMOVE_FAILED)
      setState((previous) => (previous.data ? { ...previous, data: { ...previous.data, items: previous.data.items.filter((item) => item.id !== id) } } : previous))
      refresh()
      return null
    } catch {
      return REMOVE_FAILED
    }
  }, [refresh])

  return { data: current.data, error: current.error, loadingMore: current.loadingMore, refresh, loadMore, remove }
}
