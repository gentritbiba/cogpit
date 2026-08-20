import { useCallback, useEffect, useState } from "react"
import { authFetch } from "@/lib/auth"
import type { UsageCostSummary } from "@/lib/usagePricing"

interface UsageCostState {
  summary: UsageCostSummary | null
  loading: boolean
  error: string | null
}

/**
 * Raw API cost summary for the trailing `days` window, bucketed in the
 * browser's time zone. `enabled: false` defers the scan until the surface is
 * actually shown — a cold scan reads every transcript in the window.
 */
export function useUsageCost(days: number, enabled: boolean): UsageCostState & {
  refresh: () => void
} {
  const [state, setState] = useState<UsageCostState>({
    summary: null,
    loading: false,
    error: null,
  })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setState((prev) => ({ ...prev, loading: true, error: null }))

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    authFetch(`/api/usage-cost?days=${days}&tz=${encodeURIComponent(timeZone)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Usage scan failed (${res.status})`)
        const summary = (await res.json()) as UsageCostSummary
        setState({ summary, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : "Usage scan failed",
        }))
      })

    return () => controller.abort()
  }, [days, enabled, generation])

  const refresh = useCallback(() => setGeneration((n) => n + 1), [])

  return { ...state, refresh }
}
