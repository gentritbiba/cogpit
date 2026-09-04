import { useCallback, useEffect, useState } from "react"
import { authFetch } from "@/lib/auth"
import type { SessionUsageCostSummary } from "../../shared/contracts/usageCost"

interface SessionUsageCostState {
  summary: SessionUsageCostSummary | null
  loading: boolean
  error: string | null
}

export function useSessionUsageCost(
  dirName: string | null,
  fileName: string | null,
  revision: string,
): SessionUsageCostState & { refresh: () => void } {
  const [state, setState] = useState<SessionUsageCostState>({
    summary: null,
    loading: false,
    error: null,
  })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    setState({ summary: null, loading: Boolean(dirName && fileName), error: null })
  }, [dirName, fileName])

  useEffect(() => {
    if (!dirName || !fileName) return
    const controller = new AbortController()
    setState((previous) => ({ ...previous, loading: true, error: null }))

    const query = new URLSearchParams({ dirName, fileName })
    authFetch(`/api/usage-cost/session?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Cost scan failed (${response.status})`)
        const summary = (await response.json()) as SessionUsageCostSummary
        setState({ summary, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : "Cost scan failed",
        }))
      })

    return () => controller.abort()
  }, [dirName, fileName, generation, revision])

  const refresh = useCallback(() => setGeneration((value) => value + 1), [])
  return { ...state, refresh }
}
