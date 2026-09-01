import { useCallback, useEffect, useMemo, useState } from "react"

import { authFetch } from "@/lib/auth"
import { parsePullRequestSearch } from "../../shared/session/sessionSearch"

const SEARCH_DELAY_MS = 250
const INDEX_POLL_MS = 400

interface SearchState<T> {
  results: T[] | null
  loading: boolean
  error: string | null
}

const IDLE_STATE = { results: null, loading: false, error: null }

export function usePullRequestSessionSearch<T>(query: string, project?: string) {
  const pullRequestSearch = useMemo(() => parsePullRequestSearch(query), [query])
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<SearchState<T>>(IDLE_STATE)

  useEffect(() => {
    if (!pullRequestSearch) {
      setState(IDLE_STATE)
      return
    }

    const controller = new AbortController()
    setState({ results: null, loading: true, error: null })
    let pollTimeout: ReturnType<typeof setTimeout> | null = null

    const search = async () => {
      const params = new URLSearchParams({ search: query.trim(), limit: "200" })
      if (project) params.set("project", project)
      try {
        const response = await authFetch(`/api/active-sessions?${params}`, {
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Search failed (${response.status})`)
        const body: unknown = await response.json()
        if (controller.signal.aborted) return

        const pending = Number(response.headers.get("X-Cogpit-PR-Index-Pending") ?? "0")
        if (Number.isFinite(pending) && pending > 0) {
          pollTimeout = setTimeout(() => { void search() }, INDEX_POLL_MS)
          return
        }
        setState({
          results: Array.isArray(body) ? body as T[] : [],
          loading: false,
          error: null,
        })
      } catch (error: unknown) {
        if (controller.signal.aborted) return
        setState({
          results: [],
          loading: false,
          error: error instanceof Error ? error.message : "Search failed",
        })
      }
    }

    const timeout = setTimeout(() => { void search() }, SEARCH_DELAY_MS)

    return () => {
      clearTimeout(timeout)
      if (pollTimeout) clearTimeout(pollTimeout)
      controller.abort()
    }
  }, [project, pullRequestSearch, query, retry])

  const refresh = useCallback(() => setRetry((value) => value + 1), [])
  return { ...state, active: pullRequestSearch !== null, refresh }
}
