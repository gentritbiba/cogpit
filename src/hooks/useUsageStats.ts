import { useState, useEffect, useCallback } from "react"
import { authFetch } from "@/lib/auth"

export interface UsageStats {
  sessionWindow: { outputTokens: number; resetAt: string }
  weekly: { outputTokens: number; resetAt: string }
  subscriptionType: string | null
}

// Rough output-token limits per 5h window by subscription type.
// These are approximations — Anthropic doesn't publish exact numbers.
const SESSION_LIMITS: Record<string, number> = {
  max: 500_000,
  pro: 100_000,
}

const WEEKLY_MULTIPLIER = 14 // ~14 session windows per week

export function getSessionLimit(subType: string | null): number {
  return SESSION_LIMITS[(subType ?? "").toLowerCase()] ?? 200_000
}

export function getWeeklyLimit(subType: string | null): number {
  return getSessionLimit(subType) * WEEKLY_MULTIPLIER
}

export function useUsageStats(pollIntervalMs = 120_000) {
  const [usage, setUsage] = useState<UsageStats | null>(null)

  const fetchUsage = useCallback(async () => {
    try {
      const res = await authFetch("/api/usage")
      if (!res.ok) return
      const data: UsageStats = await res.json()
      setUsage(data)
    } catch {
      // silently fail — usage is non-critical
    }
  }, [])

  useEffect(() => {
    fetchUsage()
    const id = setInterval(fetchUsage, pollIntervalMs)
    return () => clearInterval(id)
  }, [fetchUsage, pollIntervalMs])

  return usage
}
