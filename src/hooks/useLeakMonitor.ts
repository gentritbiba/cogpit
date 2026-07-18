import { useCallback, useEffect, useRef, useState } from "react"

import { authFetch } from "@/lib/auth"
import type { SystemProcessMetric, SystemProcessesResponse } from "@/lib/performanceTypes"

const POLL_INTERVAL_MS = 60_000

/**
 * Polls the system-wide agent process scan so the top bar can warn about
 * leaked processes (and kill them) even while the power monitor is closed.
 */
export function useLeakMonitor() {
  const [leaks, setLeaks] = useState<SystemProcessMetric[]>([])
  const [killing, setKilling] = useState(false)
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const response = await authFetch("/api/system-processes")
      if (response.ok) {
        const data = await response.json() as SystemProcessesResponse
        setLeaks((data.processes ?? []).filter((metric) => metric.suspectedLeak))
      }
    } catch {
      // Offline or server restarting — keep the last known state.
    } finally {
      inFlight.current = false
    }
  }, [])

  const killLeaks = useCallback(async (pids: number[]) => {
    if (pids.length === 0) return
    setKilling(true)
    try {
      await authFetch("/api/system-processes/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pids }),
      })
      // SIGTERM needs a moment to take effect before the state is re-scanned.
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      await refresh()
    } catch {
      // Kill is best-effort; the next poll shows the real state.
    } finally {
      setKilling(false)
    }
  }, [refresh])

  useEffect(() => {
    void refresh()
    // Each poll spawns a full process scan server-side — skip while hidden.
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [refresh])

  return { leaks, killing, killLeaks, refresh }
}
