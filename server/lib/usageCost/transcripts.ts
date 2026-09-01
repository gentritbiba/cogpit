/**
 * Pure line parsers for the provider CLIs' on-disk session transcripts.
 *
 * The parsers work line-at-a-time so callers can stream large files without
 * materialising them. Neither touches the filesystem. Ported from T3 Code's
 * usage scanner (itself modelled on ccusage).
 */
import type { UsageCostProvider, UsageCostTokenTotals } from "../../../shared/contracts/usageCost"
import { totalUsageCostTokens } from "../../../shared/contracts/usageCost"

export interface UsageCostRecord {
  provider: UsageCostProvider
  timestampMs: number
  model: string
  sessionId: string
  totals: UsageCostTokenTotals
  reportedCostUsd: number | null
  /** Key for cross-file de-duplication, or null when inherently unique. */
  dedupeKey: string | null
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return null
  }
}

/**
 * Cheap substring gate applied before JSON.parse. Transcripts are mostly tool
 * output; only a minority of lines carry usage.
 */
export function mightCarryUsage(line: string, provider: UsageCostProvider): boolean {
  if (provider === "claude") return line.includes('"usage"')
  if (provider === "codex") return line.includes('"token_count"')
  return line.includes('"session.shutdown"') && line.includes('"modelMetrics"')
}

/**
 * Parses one line of a Claude Code transcript.
 *
 * Claude Code writes one record per assistant content block, and each repeats
 * the parent message's complete `usage` object — summing them overcounts by
 * ~2.4x. Callers must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeUsageLine(line: string): UsageCostRecord | null {
  const record = parseJsonRecord(line)
  if (!record || record.type !== "assistant") return null

  const message = asRecord(record.message)
  const usage = message ? asRecord(message.usage) : null
  if (!message || !usage) return null

  const timestampMs = parseTimestampMs(record.timestamp)
  if (timestampMs === null) return null

  const model = typeof message.model === "string" ? message.model : ""
  if (model.length === 0) return null

  const messageId = typeof message.id === "string" ? message.id : null
  const requestId = typeof record.requestId === "string" ? record.requestId : null
  // Matches ccusage: prefer the message/request pair, fall back to whichever
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`

  const cacheCreationTokens = int(usage.cache_creation_input_tokens)
  const byTtl = asRecord(usage.cache_creation)

  const totals: UsageCostTokenTotals = {
    uncachedInputTokens: int(usage.input_tokens),
    cachedInputTokens: int(usage.cache_read_input_tokens),
    cacheCreationTokens,
    // Priced at a premium, so never let a malformed breakdown claim more of
    // the write than the write itself reports.
    cacheCreation1hTokens: Math.min(
      cacheCreationTokens,
      byTtl ? int(byTtl.ephemeral_1h_input_tokens) : 0,
    ),
    outputTokens: int(usage.output_tokens),
    // Anthropic folds thinking tokens into output and does not break them out.
    reasoningTokens: 0,
  }

  // <synthetic> lines and other locally generated messages carry all-zero
  // usage; letting them through puts junk rows in the model breakdown.
  if (totalUsageCostTokens(totals) === 0) return null

  const cost = record.costUSD

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
    totals,
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    dedupeKey,
  }
}

/**
 * Rolling state for a single Codex rollout file. Codex `token_count` events
 * carry no model, so it is carried forward from the latest `turn_context`.
 */
export interface CodexScanState {
  model: string
  sessionId: string
  lastUsageSignature: string | null
  sawSessionMeta: boolean
  /** While true, leading usage events are re-stamped copies of parent history. */
  suppressingForkCopies: boolean
  forkCopyAnchorMs: number
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  }
}

/**
 * A forked or subagent rollout opens with the parent's full history copied in,
 * every line re-stamped to the fork instant, written in one synchronous burst.
 * The child's first genuine usage event only lands after a real model turn, so
 * one second of separation splits the two cleanly (same threshold as ccusage).
 */
const FORK_COPY_MAX_GAP_MS = 1000

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === "string") return true
  const spawn = asRecord(asRecord(asRecord(payload.source)?.subagent)?.thread_spawn)
  return typeof spawn?.parent_thread_id === "string"
}

/**
 * Feeds one line of a Codex rollout into `state`, returning a record when the
 * line was a usage event. Deltas come from `last_token_usage`; consecutive
 * duplicate events (re-emitted on stream boundaries) are dropped.
 */
export function parseCodexUsageLine(line: string, state: CodexScanState): UsageCostRecord | null {
  const record = parseJsonRecord(line)
  if (!record) return null
  const payload = asRecord(record.payload)
  if (!payload) return null

  if (record.type === "session_meta") {
    // Only the first meta describes this file's own session; a forked rollout
    // repeats the ancestors' metas right after it.
    if (state.sawSessionMeta) return null
    state.sawSessionMeta = true
    const id = payload.id ?? payload.session_id
    if (typeof id === "string") state.sessionId = id
    const metaTimestampMs = parseTimestampMs(record.timestamp)
    if (metaTimestampMs !== null && isForkedSessionMeta(payload)) {
      state.suppressingForkCopies = true
      state.forkCopyAnchorMs = metaTimestampMs
    }
    return null
  }

  if (record.type === "turn_context") {
    if (typeof payload.model === "string") state.model = payload.model
    return null
  }

  if (payload.type !== "token_count") return null

  const last = asRecord(asRecord(payload.info)?.last_token_usage)
  if (!last) return null

  // Only an otherwise-eligible event may consume the duplicate signature: a
  // token_count arriving before its turn_context (no model yet) must not
  // poison it, or the re-emitted copy after the model is known would be
  // skipped as a duplicate and those tokens never counted.
  const timestampMs = parseTimestampMs(record.timestamp)
  if (timestampMs === null) return null
  if (state.model.length === 0) return null

  const signature = JSON.stringify(last)
  if (signature === state.lastUsageSignature) return null
  state.lastUsageSignature = signature

  // In a forked rollout the copied parent history was already counted from the
  // parent's own file. Drop the leading burst; the first usage event separated
  // from its predecessor by a real turn's worth of time ends it for good.
  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs
      return null
    }
    state.suppressingForkCopies = false
  }

  const inputTokens = int(last.input_tokens)
  const cachedInputTokens = int(last.cached_input_tokens)
  const cacheCreationTokens = int(last.cache_write_input_tokens)
  const outputTokens = int(last.output_tokens)

  const totals: UsageCostTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    // Codex reports no cache TTL split.
    cacheCreation1hTokens: 0,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: Math.min(outputTokens, int(last.reasoning_output_tokens)),
  }

  if (totalUsageCostTokens(totals) === 0) return null

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    // Codex does not report cost in the rollout.
    reportedCostUsd: null,
    // Events surviving fork-copy suppression are unique to this rollout.
    dedupeKey: null,
  }
}

export interface CopilotScanState {
  sessionId: string
  lastUsageByModel: Map<string, UsageCostTokenTotals>
}

export function initialCopilotScanState(sessionId = ""): CopilotScanState {
  return { sessionId, lastUsageByModel: new Map() }
}

function cumulativeDelta(current: number, previous: number): number {
  return current >= previous ? current - previous : current
}

function usageDelta(
  current: UsageCostTokenTotals,
  previous: UsageCostTokenTotals | undefined,
): UsageCostTokenTotals {
  if (!previous) return current
  const outputTokens = cumulativeDelta(current.outputTokens, previous.outputTokens)
  return {
    uncachedInputTokens: cumulativeDelta(current.uncachedInputTokens, previous.uncachedInputTokens),
    cachedInputTokens: cumulativeDelta(current.cachedInputTokens, previous.cachedInputTokens),
    cacheCreationTokens: cumulativeDelta(current.cacheCreationTokens, previous.cacheCreationTokens),
    cacheCreation1hTokens: 0,
    outputTokens,
    reasoningTokens: Math.min(
      outputTokens,
      cumulativeDelta(current.reasoningTokens, previous.reasoningTokens),
    ),
  }
}

/** Convert Copilot's cumulative runtime/shutdown metrics into new usage only. */
export function parseCopilotUsageMetrics(
  value: unknown,
  state: CopilotScanState,
  timestampMs: number,
): UsageCostRecord[] {
  const metrics = asRecord(value)
  const modelMetrics = metrics ? asRecord(metrics.modelMetrics) : null
  if (!metrics || !modelMetrics || !Number.isFinite(timestampMs)) return []

  const records: UsageCostRecord[] = []
  for (const [model, rawMetric] of Object.entries(modelMetrics)) {
    const usage = asRecord(asRecord(rawMetric)?.usage)
    if (!usage || model.length === 0) continue

    const inputTokens = int(usage.inputTokens)
    const cachedInputTokens = int(usage.cacheReadTokens)
    const cacheCreationTokens = int(usage.cacheWriteTokens)
    const outputTokens = int(usage.outputTokens)
    const current: UsageCostTokenTotals = {
      // Copilot's aggregate input count includes both cache categories.
      uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
      cachedInputTokens,
      cacheCreationTokens,
      cacheCreation1hTokens: 0,
      outputTokens,
      reasoningTokens: Math.min(outputTokens, int(usage.reasoningTokens)),
    }
    const totals = usageDelta(current, state.lastUsageByModel.get(model))
    state.lastUsageByModel.set(model, current)
    if (totalUsageCostTokens(totals) === 0) continue

    records.push({
      provider: "copilot",
      timestampMs,
      model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd: null,
      dedupeKey: null,
    })
  }
  return records
}

/**
 * Parses Copilot's durable per-model usage snapshot. Individual
 * `assistant.usage` events are ephemeral, so shutdown metrics are the only
 * complete token breakdown available in an on-disk session.
 */
export function parseCopilotUsageLine(
  line: string,
  state: CopilotScanState,
): UsageCostRecord[] {
  const record = parseJsonRecord(line)
  if (!record || (typeof record.agentId === "string" && record.agentId.length > 0)) return []
  const data = asRecord(record.data)
  if (!data) return []

  if (record.type === "session.start") {
    const sessionId = data.sessionId
    if (typeof sessionId === "string" && sessionId.length > 0) state.sessionId = sessionId
    return []
  }

  if (record.type !== "session.shutdown") return []
  const timestampMs = parseTimestampMs(record.timestamp)
  return timestampMs === null ? [] : parseCopilotUsageMetrics(data, state, timestampMs)
}
