/**
 * What the renderer reads from a session's raw records, computed where the
 * records are kept (the parser worker), so the records themselves never cross
 * to the main thread. A `SessionView` is a parsed session with its records
 * swapped for this digest.
 */
import { formatForRecords } from "./agents"
import { computeContextUsage, type ContextUsage } from "./contextWindow"
import type { ParsedSession, RawRecord, SessionStatusInfo } from "./types"

export type TranscriptGoalStatus = "active" | "achieved" | "failed"

export interface TranscriptGoalState {
  condition: string
  status: TranscriptGoalStatus
  reason?: string
  iterations: number
  durationMs: number
  tokens: number
}

/** The model a turn fell back to after the requested one refused it. */
export interface ModelFallbackNotice {
  /** Identifies the record, so a notice is shown once. */
  id: string
  originalModel: string | null
  fallbackModel: string | null
  explanation: string | null
}

export interface SessionDigest {
  status: SessionStatusInfo
  /** Context pressure from the last response that reported usage. */
  contextUsage: ContextUsage | null
  /** The goal the transcript last recorded, or null when none is set. */
  goal: TranscriptGoalState | null
  modelFallback: ModelFallbackNotice | null
}

export type SessionView = Omit<ParsedSession, "rawMessages"> & { digest: SessionDigest }

export const EMPTY_SESSION_DIGEST: SessionDigest = Object.freeze({
  status: Object.freeze({ status: "idle" as const }),
  contextUsage: null,
  goal: null,
  modelFallback: null,
})

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** The goal a `goal_status` attachment records; a met sentinel is an explicit clear. */
function goalFrom(attachment: Record<string, unknown>): TranscriptGoalState | null {
  const condition = typeof attachment.condition === "string" ? attachment.condition : ""
  const met = attachment.met === true
  if (attachment.sentinel === true && met) return null
  if (!condition) return null
  return {
    condition,
    status: attachment.failed === true ? "failed" : met ? "achieved" : "active",
    reason: typeof attachment.reason === "string" ? attachment.reason : undefined,
    iterations: typeof attachment.iterations === "number" ? attachment.iterations : 0,
    durationMs: typeof attachment.durationMs === "number" ? attachment.durationMs : 0,
    tokens: typeof attachment.tokens === "number" ? attachment.tokens : 0,
  }
}

function fallbackFrom(record: RawRecord): ModelFallbackNotice {
  const text = (value: unknown) => typeof value === "string" ? value : null
  return {
    id: text(record.uuid) ?? `${String(record.original_model)}:${String(record.fallback_model)}:${String(record.request_id)}`,
    originalModel: text(record.original_model),
    fallbackModel: text(record.fallback_model),
    explanation: text(record.api_refusal_explanation),
  }
}

/**
 * The digest of `records`. With `previous`, the digest of `records` up to
 * `scannedTo`, only the records after it are searched for the facts that the
 * latest record of a kind decides; status is always derived from all of them.
 */
export function computeSessionDigest(
  records: readonly RawRecord[],
  previous?: { digest: SessionDigest; scannedTo: number },
): SessionDigest {
  const format = formatForRecords(records)
  const stop = previous ? Math.min(previous.scannedTo, records.length) : 0
  let contextUsage: ContextUsage | null | undefined
  let goal: TranscriptGoalState | null | undefined
  let modelFallback: ModelFallbackNotice | null | undefined
  for (let index = records.length - 1; index >= stop; index--) {
    if (contextUsage !== undefined && goal !== undefined && modelFallback !== undefined) break
    const record = records[index]!
    if (record.type === "assistant" && contextUsage === undefined) {
      const message = asRecord(record.message)
      contextUsage = computeContextUsage(asRecord(message?.usage) ?? {}, typeof message?.model === "string" ? message.model : "", format.kind)
    } else if (record.type === "attachment" && goal === undefined) {
      const attachment = asRecord(record.attachment)
      if (attachment?.type === "goal_status") goal = goalFrom(attachment)
    } else if (record.type === "system" && record.subtype === "model_refusal_fallback" && modelFallback === undefined) {
      modelFallback = fallbackFrom(record)
    }
  }
  const before = previous?.digest ?? EMPTY_SESSION_DIGEST
  return {
    status: format.status(records),
    contextUsage: contextUsage === undefined ? before.contextUsage : contextUsage,
    goal: goal === undefined ? before.goal : goal,
    modelFallback: modelFallback === undefined ? before.modelFallback : modelFallback,
  }
}

/** The session as the renderer holds it: everything but its raw records, plus their digest. */
export function toSessionView(session: ParsedSession, digest = computeSessionDigest(session.rawMessages)): SessionView {
  const { rawMessages: _records, ...view } = session
  return { ...view, digest }
}
