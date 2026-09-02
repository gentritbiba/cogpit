import { useEffect, useState, useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"
import { DEFAULT_AGENT_KIND, type AgentKind } from "@/lib/agents"
import { quotaSourceFor, type UsageData } from "@/lib/agents/quota"
import { useCapability } from "@/hooks/useCapability"

export type { UsageData } from "@/lib/agents/quota"

interface UseTokenUsageResult {
  usage: UsageData | null
  loading: boolean
  available: boolean
  refresh: () => void
}

const POLL_INTERVAL = 5 * 60 * 1000

export function useTokenUsage(agentKind: AgentKind = DEFAULT_AGENT_KIND): UseTokenUsageResult {
  const canViewUsage = useCapability("viewUsage")
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(false)
  const [available, setAvailable] = useState(false)
  const requestIdRef = useRef(0)
  const activeRequestRef = useRef<AbortController | null>(null)

  const fetchUsage = useCallback(async () => {
    if (!canViewUsage) return
    // A monotonic id plus an abort controller, so a slow response in one
    // agent's shape can never reach another agent's reader after a switch.
    const requestId = ++requestIdRef.current
    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller
    const isCurrentRequest = () => (
      requestIdRef.current === requestId && !controller.signal.aborted
    )

    setLoading(true)
    try {
      const source = quotaSourceFor(agentKind)
      let res = await authFetch(source.endpoint, { signal: controller.signal })
      let read = source.read
      if (source.legacy && !res.ok && !controller.signal.aborted) {
        res = await authFetch(source.legacy.endpoint, { signal: controller.signal })
        read = source.legacy.read
      }
      if (!isCurrentRequest()) return

      if (res.status === 501 || res.status === 404) {
        setAvailable(false)
        return
      }

      if (!res.ok) {
        // Credentials found (available) but API failed — keep showing stale data
        setAvailable(true)
        return
      }

      const data = await res.json() as Record<string, unknown>
      if (!isCurrentRequest()) return
      const mapped = read(data)
      setAvailable(mapped !== null)
      setUsage(mapped ? { ...mapped, agentKind, fetchedAt: Date.now() } : null)
    } catch {
      // Network error — don't change available state or clear existing data
    } finally {
      if (isCurrentRequest()) {
        activeRequestRef.current = null
        setLoading(false)
      }
    }
  }, [agentKind, canViewUsage])

  useEffect(() => {
    setUsage(null)
    setAvailable(false)
    if (!canViewUsage) {
      setLoading(false)
      requestIdRef.current += 1
      activeRequestRef.current?.abort()
      activeRequestRef.current = null
      return
    }
    fetchUsage()
    const id = setInterval(fetchUsage, POLL_INTERVAL)
    return () => {
      clearInterval(id)
      requestIdRef.current += 1
      activeRequestRef.current?.abort()
      activeRequestRef.current = null
    }
  }, [agentKind, canViewUsage, fetchUsage])

  return {
    usage: canViewUsage ? usage : null,
    loading: canViewUsage && loading,
    available: canViewUsage && available,
    refresh: fetchUsage,
  }
}
