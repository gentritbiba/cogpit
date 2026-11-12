import { useCallback, useEffect, useState } from "react"
import { authFetch } from "@/lib/auth"
import { listUrl, type ListFilter } from "@/lib/sessionListFilter"
import { onListsStale } from "@/lib/sessionAccess"
import type { SessionSearchResponse } from "../../shared/contracts/sessionSearch"

export function useSessionContentSearch(query: string, filter: ListFilter, cwd?: string) {
  const trimmed = query.trim()
  const active = trimmed.length >= 2
  const [retry, setRetry] = useState(0)
  const [response, setResponse] = useState<SessionSearchResponse | null>(null)
  const refresh = useCallback(() => {
    setResponse(null)
    setRetry((value) => value + 1)
  }, [])

  useEffect(() => {
    setResponse(null)
    if (!active) return
    const controller = new AbortController()
    let poll: ReturnType<typeof setTimeout> | undefined
    const search = async () => {
      const params = new URLSearchParams({ q: trimmed, limit: "12" })
      if (cwd) params.set("cwd", cwd)
      try {
        const result = await authFetch(listUrl("/api/session-search", filter, params), { signal: controller.signal })
        if (!result.ok) throw new Error("Search unavailable")
        const body = await result.json() as SessionSearchResponse
        if (controller.signal.aborted) return
        setResponse(body)
        if (body.indexing.pendingFiles > 0 || (body.semantic.state === "ready" && body.indexing.pendingEmbeddings > 0)) {
          poll = setTimeout(() => { void search() }, 1000)
        }
      } catch {
        if (!controller.signal.aborted) setResponse(null)
      }
    }
    const debounce = setTimeout(() => { void search() }, 250)
    return () => {
      clearTimeout(debounce)
      clearTimeout(poll)
      controller.abort()
    }
  }, [active, trimmed, filter, cwd, retry])

  useEffect(() => active ? onListsStale(refresh) : undefined, [active, refresh])
  return { response: active ? response : null, refresh }
}
