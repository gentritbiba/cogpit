import { useEffect, useState, useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"
import { DEFAULT_AGENT_KIND, type AgentKind } from "@/lib/agents"
import { useCapability } from "@/hooks/useCapability"

interface UsageBucket {
  utilization: number
  resetsAt?: string
  label?: string
}

export interface UsageData {
  /** Agent this snapshot came from; names and colours are derived from it. */
  agentKind?: AgentKind
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

// ── Shared normalisation ──────────────────────────────────────────────────
//
// Every runtime reports its quota in its own shape, but a meter is a meter:
// one number between 0 and 100, an optional reset instant and an optional
// label. The per-agent readers below only locate those three values; clamping
// and shaping happen here, once.

function usageBucket(
  utilization: number | undefined,
  resetsAt?: string,
  label?: string,
): UsageBucket | undefined {
  if (utilization === undefined || !Number.isFinite(utilization)) return undefined
  return {
    utilization: Math.min(100, Math.max(0, utilization)),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(label === undefined ? {} : { label }),
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

// ── Per-runtime readers ───────────────────────────────────────────────────

/** Anthropic-shaped `{ utilization, resets_at }`. */
function anthropicBucket(raw: Record<string, unknown> | undefined): UsageBucket | undefined {
  return raw ? usageBucket(num(raw.utilization), str(raw.resets_at)) : undefined
}

function anthropicExtraUsage(raw: Record<string, unknown> | undefined): UsageData["extraUsage"] {
  if (!raw) return undefined
  return {
    isEnabled: !!raw.is_enabled,
    monthlyLimit: num(raw.monthly_limit),
    usedCredits: num(raw.used_credits),
    utilization: num(raw.utilization),
  }
}

/**
 * The macOS-keychain path, kept only as a fallback for a Claude Code that
 * predates structured usage on its own control channel.
 */
export function mapLegacyClaudeUsage(data: Record<string, unknown>): UsageData {
  return {
    fiveHour: anthropicBucket(asObject(data.five_hour)),
    sevenDay: anthropicBucket(asObject(data.seven_day)),
    sevenDayOpus: anthropicBucket(asObject(data.seven_day_opus)),
    sevenDaySonnet: anthropicBucket(asObject(data.seven_day_sonnet)),
    extraUsage: anthropicExtraUsage(asObject(data.extra_usage)),
    subscriptionType: str(data.subscriptionType),
  }
}

export function mapClaudeRuntimeResponse(data: Record<string, unknown>): UsageData | null {
  if (data.available !== true) return null
  const usage = asObject(data.usage)
  const limits = asObject(usage?.rate_limits)
  const account = asObject(data.account)
  const mapped: UsageData = {
    fiveHour: anthropicBucket(asObject(limits?.five_hour)),
    sevenDay: anthropicBucket(asObject(limits?.seven_day)),
    sevenDayOpus: anthropicBucket(asObject(limits?.seven_day_opus)),
    sevenDaySonnet: anthropicBucket(asObject(limits?.seven_day_sonnet)),
    extraUsage: anthropicExtraUsage(asObject(limits?.extra_usage)),
    subscriptionType: str(usage?.subscription_type) ?? str(account?.subscriptionType),
  }
  return mapped.fiveHour || mapped.sevenDay || mapped.extraUsage || mapped.subscriptionType
    ? mapped
    : null
}

function codexResetTime(value: unknown): string | undefined {
  const seconds = num(value)
  if (seconds === undefined) return undefined
  // App-server reports Unix seconds; tolerate milliseconds for forwards
  // compatibility with alternate providers.
  return new Date(seconds < 10_000_000_000 ? seconds * 1000 : seconds).toISOString()
}

function codexWindowLabel(minutes: unknown, fallback: string): string {
  const value = num(minutes)
  if (value === undefined || value <= 0) return fallback
  if (value % 1440 === 0) return `${value / 1440}-day`
  if (value % 60 === 0) return `${value / 60}-hour`
  return `${value}-minute`
}

function codexBucket(
  raw: Record<string, unknown> | undefined,
  fallbackLabel: string,
): UsageBucket | undefined {
  if (!raw) return undefined
  return usageBucket(
    num(raw.usedPercent),
    codexResetTime(raw.resetsAt),
    codexWindowLabel(raw.windowDurationMins, fallbackLabel),
  )
}

/** Map the app-server runtime response into the shared header UI. */
export function mapCodexRuntimeResponse(data: Record<string, unknown>): UsageData | null {
  if (data.available !== true) return null
  const snapshot = asObject(asObject(data.rateLimits)?.rateLimits)
  const account = asObject(asObject(data.account)?.account)
  const summary = asObject(asObject(data.usage)?.summary)
  const credits = asObject(snapshot?.credits)
  const primary = codexBucket(asObject(snapshot?.primary), "Primary")
  const secondary = codexBucket(asObject(snapshot?.secondary), "Secondary")
  const lifetime = summary?.lifetimeTokens
  const lifetimeTokens = num(lifetime)
    ?? (typeof lifetime === "string" && Number.isSafeInteger(Number(lifetime))
      ? Number(lifetime)
      : undefined)

  if (!primary && !secondary && lifetimeTokens === undefined) return null
  return {
    fiveHour: primary,
    sevenDay: secondary,
    subscriptionType: str(snapshot?.planType) ?? str(account?.planType),
    lifetimeTokens,
    creditBalance: str(credits?.balance),
    creditsUnlimited: credits?.unlimited === true,
  }
}

function copilotQuotaBucket(
  raw: Record<string, unknown> | undefined,
  label: string,
): UsageBucket | undefined {
  if (!raw) return undefined
  const remaining = num(raw.remainingPercentage)
  const used = num(raw.usedRequests)
  const entitlement = num(raw.entitlementRequests)

  let utilization: number | undefined
  if (remaining !== undefined) utilization = 100 - remaining
  else if (raw.isUnlimitedEntitlement === true || entitlement === -1) utilization = 0
  else if (used !== undefined && entitlement !== undefined && entitlement > 0) {
    utilization = used / entitlement * 100
  }
  return usageBucket(utilization, str(raw.resetDate), label)
}

/** Map Copilot's account quota into the primary shared usage meter. */
export function mapCopilotRuntimeResponse(data: Record<string, unknown>): UsageData | null {
  if (data.available !== true) return null
  const snapshots = asObject(asObject(data.quota)?.quotaSnapshots)
  const primary = copilotQuotaBucket(asObject(snapshots?.chat), "Chat")
    ?? copilotQuotaBucket(asObject(snapshots?.premium_interactions), "Premium interactions")
  return primary ? { fiveHour: primary } : null
}

// ── The table ─────────────────────────────────────────────────────────────

interface QuotaSource {
  /** Endpoint carrying this agent's live quota. */
  endpoint: string
  /** Reads that endpoint's own response shape into the shared meter. */
  read(data: Record<string, unknown>): UsageData | null
  /** Older runtime shape, tried only when the primary endpoint fails. */
  legacy?: { endpoint: string; read(data: Record<string, unknown>): UsageData | null }
}

const QUOTA_SOURCES: Record<AgentKind, QuotaSource> = {
  claude: {
    endpoint: "/api/claude/runtime",
    read: mapClaudeRuntimeResponse,
    legacy: { endpoint: "/api/usage", read: mapLegacyClaudeUsage },
  },
  codex: { endpoint: "/api/codex/runtime", read: mapCodexRuntimeResponse },
  copilot: { endpoint: "/api/copilot/runtime", read: mapCopilotRuntimeResponse },
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
      const source = QUOTA_SOURCES[agentKind]
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
