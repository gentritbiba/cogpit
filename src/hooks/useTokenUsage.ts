import { useEffect, useState, useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"
import type { AgentKind } from "@/lib/sessionSource"
import { useCapability } from "@/hooks/useCapability"

interface UsageBucket {
  utilization: number
  resetsAt?: string
  label?: string
}

export interface UsageData {
  providerName?: "Claude" | "Codex" | "Copilot"
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

function mapCopilotQuotaBucket(
  raw: Record<string, unknown> | undefined,
  label: string,
): UsageBucket | undefined {
  if (!raw) return undefined
  let utilization: number | undefined
  if (typeof raw.remainingPercentage === "number" && Number.isFinite(raw.remainingPercentage)) {
    utilization = 100 - raw.remainingPercentage
  } else if (raw.isUnlimitedEntitlement === true || raw.entitlementRequests === -1) {
    utilization = 0
  } else if (
    typeof raw.usedRequests === "number"
    && Number.isFinite(raw.usedRequests)
    && typeof raw.entitlementRequests === "number"
    && Number.isFinite(raw.entitlementRequests)
    && raw.entitlementRequests > 0
  ) {
    utilization = raw.usedRequests / raw.entitlementRequests * 100
  }
  if (utilization === undefined) return undefined
  return {
    utilization: Math.min(100, Math.max(0, utilization)),
    resetsAt: typeof raw.resetDate === "string" ? raw.resetDate : undefined,
    label,
  }
}

/** Map Copilot's account quota into the primary shared usage meter. */
export function mapCopilotRuntimeResponse(data: Record<string, unknown>): UsageData | null {
  if (data.available !== true) return null
  const quota = asObject(data.quota)
  const snapshots = asObject(quota?.quotaSnapshots)
  const primary = mapCopilotQuotaBucket(asObject(snapshots?.chat), "Chat")
    ?? mapCopilotQuotaBucket(
      asObject(snapshots?.premium_interactions),
      "Premium interactions",
    )
  if (!primary) return null
  return { providerName: "Copilot", fiveHour: primary }
}

const POLL_INTERVAL = 5 * 60 * 1000
const RUNTIME_ENDPOINTS: Record<AgentKind, string> = {
  claude: "/api/claude/runtime",
  codex: "/api/codex/runtime",
  copilot: "/api/copilot/runtime",
}

export function useTokenUsage(agentKind: AgentKind = "claude"): UseTokenUsageResult {
  const canViewUsage = useCapability("viewUsage")
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(false)
  const [available, setAvailable] = useState(false)
  const requestIdRef = useRef(0)
  const activeRequestRef = useRef<AbortController | null>(null)

  const fetchUsage = useCallback(async () => {
    if (!canViewUsage) return
    const requestId = ++requestIdRef.current
    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller
    const isCurrentRequest = () => (
      requestIdRef.current === requestId && !controller.signal.aborted
    )

    setLoading(true)
    try {
      let res = await authFetch(RUNTIME_ENDPOINTS[agentKind], {
        signal: controller.signal,
      })
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
      let mapped: UsageData | null
      if (agentKind === "codex") mapped = mapCodexRuntimeResponse(data)
      else if (agentKind === "copilot") mapped = mapCopilotRuntimeResponse(data)
      else {
        mapped = usedLegacyClaudeUsage
          ? mapUsageResponse(data)
          : mapClaudeRuntimeResponse(data)
      }
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
