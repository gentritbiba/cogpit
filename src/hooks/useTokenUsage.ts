import { useEffect, useState, useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"
import type { AgentKind } from "@/lib/sessionSource"

interface UsageBucket {
  utilization: number
  resetsAt?: string
  label?: string
}

export interface UsageData {
  providerName?: "Claude" | "Codex"
  /** Client timestamp captured when this snapshot was received. */
  fetchedAt?: number
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
  lifetimeTokens?: number
  creditBalance?: string
  creditsUnlimited?: boolean
}

interface UseTokenUsageResult {
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
    providerName: "Claude",
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function mapClaudeRuntimeResponse(data: Record<string, unknown>): UsageData | null {
  if (data.available !== true) return null
  const usage = asObject(data.usage)
  const limits = asObject(usage?.rate_limits)
  const account = asObject(data.account)
  const extra = asObject(limits?.extra_usage)
  const mapped: UsageData = {
    providerName: "Claude",
    fiveHour: mapBucket(asObject(limits?.five_hour)),
    sevenDay: mapBucket(asObject(limits?.seven_day)),
    sevenDayOpus: mapBucket(asObject(limits?.seven_day_opus)),
    sevenDaySonnet: mapBucket(asObject(limits?.seven_day_sonnet)),
    extraUsage: extra
      ? {
          isEnabled: !!extra.is_enabled,
          monthlyLimit: typeof extra.monthly_limit === "number" ? extra.monthly_limit : undefined,
          usedCredits: typeof extra.used_credits === "number" ? extra.used_credits : undefined,
          utilization: typeof extra.utilization === "number" ? extra.utilization : undefined,
        }
      : undefined,
    subscriptionType: typeof usage?.subscription_type === "string"
      ? usage.subscription_type
      : typeof account?.subscriptionType === "string" ? account.subscriptionType : undefined,
  }
  return mapped.fiveHour || mapped.sevenDay || mapped.extraUsage || mapped.subscriptionType
    ? mapped
    : null
}

function codexResetTime(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  // App-server reports Unix seconds; tolerate milliseconds for forwards
  // compatibility with alternate providers.
  return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString()
}

function codexWindowLabel(minutes: unknown, fallback: string): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return fallback
  if (minutes % 1440 === 0) {
    const days = minutes / 1440
    return `${days}-day`
  }
  if (minutes % 60 === 0) return `${minutes / 60}-hour`
  return `${minutes}-minute`
}

function mapCodexBucket(raw: Record<string, unknown> | undefined, fallbackLabel: string): UsageBucket | undefined {
  if (!raw || typeof raw.usedPercent !== "number") return undefined
  return {
    utilization: raw.usedPercent,
    resetsAt: codexResetTime(raw.resetsAt),
    label: codexWindowLabel(raw.windowDurationMins, fallbackLabel),
  }
}

/** Map the provider-native app-server runtime response into the shared header UI. */
export function mapCodexRuntimeResponse(data: Record<string, unknown>): UsageData | null {
  if (data.available !== true) return null
  const rateLimitResponse = asObject(data.rateLimits)
  const snapshot = asObject(rateLimitResponse?.rateLimits)
  const accountResponse = asObject(data.account)
  const account = asObject(accountResponse?.account)
  const usageResponse = asObject(data.usage)
  const summary = asObject(usageResponse?.summary)
  const credits = asObject(snapshot?.credits)
  const primary = mapCodexBucket(asObject(snapshot?.primary), "Primary")
  const secondary = mapCodexBucket(asObject(snapshot?.secondary), "Secondary")
  const lifetime = summary?.lifetimeTokens
  const lifetimeTokens = typeof lifetime === "number"
    ? lifetime
    : typeof lifetime === "string" && Number.isSafeInteger(Number(lifetime))
      ? Number(lifetime)
      : undefined

  if (!primary && !secondary && lifetimeTokens === undefined) return null
  return {
    providerName: "Codex",
    fiveHour: primary,
    sevenDay: secondary,
    subscriptionType: typeof snapshot?.planType === "string"
      ? snapshot.planType
      : typeof account?.planType === "string" ? account.planType : undefined,
    lifetimeTokens,
    creditBalance: typeof credits?.balance === "string" ? credits.balance : undefined,
    creditsUnlimited: credits?.unlimited === true,
  }
}

const POLL_INTERVAL = 5 * 60 * 1000

export function useTokenUsage(agentKind: AgentKind = "claude"): UseTokenUsageResult {
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(false)
  const [available, setAvailable] = useState(false)
  const requestIdRef = useRef(0)
  const activeRequestRef = useRef<AbortController | null>(null)

  const fetchUsage = useCallback(async () => {
    const requestId = ++requestIdRef.current
    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller
    const isCurrentRequest = () => (
      requestIdRef.current === requestId && !controller.signal.aborted
    )

    setLoading(true)
    try {
      let res = await authFetch(
        agentKind === "codex" ? "/api/codex/runtime" : "/api/claude/runtime",
        { signal: controller.signal },
      )
      // Older Claude runtimes do not expose structured usage through the SDK.
      // Keep the existing macOS OAuth implementation as a compatibility path.
      let usedLegacyClaudeUsage = false
      if (agentKind === "claude" && !res.ok && !controller.signal.aborted) {
        res = await authFetch("/api/usage", { signal: controller.signal })
        usedLegacyClaudeUsage = true
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
      const mapped = agentKind === "codex"
        ? mapCodexRuntimeResponse(data)
        : usedLegacyClaudeUsage ? mapUsageResponse(data) : mapClaudeRuntimeResponse(data)
      setAvailable(mapped !== null)
      setUsage(mapped ? { ...mapped, fetchedAt: Date.now() } : null)
    } catch {
      // Network error — don't change available state or clear existing data
    } finally {
      if (isCurrentRequest()) {
        activeRequestRef.current = null
        setLoading(false)
      }
    }
  }, [agentKind])

  useEffect(() => {
    setUsage(null)
    setAvailable(false)
    fetchUsage()
    const id = setInterval(fetchUsage, POLL_INTERVAL)
    return () => {
      clearInterval(id)
      requestIdRef.current += 1
      activeRequestRef.current?.abort()
      activeRequestRef.current = null
    }
  }, [fetchUsage])

  return { usage, loading, available, refresh: fetchUsage }
}
