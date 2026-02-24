import { useEffect, useState, useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"

interface UsageBucket {
  utilization: number
  resetsAt?: string
}

export interface UsageData {
  fiveHour?: UsageBucket
  sevenDay?: UsageBucket
  sevenDayOpus?: UsageBucket
  sevenDaySonnet?: UsageBucket
  extraUsage?: {
    isEnabled: boolean
    monthlyLimit?: number
    usedCredits?: number
    utilization?: number
  }
  subscriptionType?: string
}

export interface UseTokenUsageResult {
  usage: UsageData | null
  loading: boolean
  available: boolean
  refresh: () => void
}

function mapBucket(raw: Record<string, unknown> | undefined): UsageBucket | undefined {
  if (!raw || typeof raw.utilization !== "number") return undefined
  return {
    utilization: raw.utilization,
    resetsAt: typeof raw.resets_at === "string" ? raw.resets_at : undefined,
  }
}

function mapUsageResponse(data: Record<string, unknown>): UsageData {
  const extra = data.extra_usage as Record<string, unknown> | undefined
  return {
    fiveHour: mapBucket(data.five_hour as Record<string, unknown> | undefined),
    sevenDay: mapBucket(data.seven_day as Record<string, unknown> | undefined),
    sevenDayOpus: mapBucket(data.seven_day_opus as Record<string, unknown> | undefined),
    sevenDaySonnet: mapBucket(data.seven_day_sonnet as Record<string, unknown> | undefined),
    extraUsage: extra
      ? {
          isEnabled: !!extra.is_enabled,
          monthlyLimit: typeof extra.monthly_limit === "number" ? extra.monthly_limit : undefined,
          usedCredits: typeof extra.used_credits === "number" ? extra.used_credits : undefined,
          utilization: typeof extra.utilization === "number" ? extra.utilization : undefined,
        }
      : undefined,
    subscriptionType: typeof data.subscriptionType === "string" ? data.subscriptionType : undefined,
  }
}

const POLL_INTERVAL = 5 * 60 * 1000

export function useTokenUsage(): UseTokenUsageResult {
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(false)
  const [available, setAvailable] = useState(false)
  const mountedRef = useRef(true)

  const fetchUsage = useCallback(async () => {
    setLoading(true)
    try {
      const res = await authFetch("/api/usage")
      if (!mountedRef.current) return

      if (res.status === 501 || res.status === 404) {
        setAvailable(false)
        return
      }

      if (!res.ok) {
        // Credentials found (available) but API failed — keep showing stale data
        setAvailable(true)
        return
      }

      const data = await res.json()
      setAvailable(true)
      setUsage(mapUsageResponse(data))
    } catch {
      // Network error — don't change available state or clear existing data
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    fetchUsage()
    const id = setInterval(fetchUsage, POLL_INTERVAL)
    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
  }, [fetchUsage])

  return { usage, loading, available, refresh: fetchUsage }
}
