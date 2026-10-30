import type { RateLimitBlock } from "../session/rateLimit"
import type { CommandReceipt } from "./orchestration"
import type { ExecutionGrant, OccurrenceHold, OccurrenceState } from "./triggers"

export const RECOVERY_MESSAGE = "Continue the interrupted task from where you stopped."

export interface RecoveryOffer {
  id: string
  block: RateLimitBlock
  /** Validated epoch milliseconds; the provider reports seconds. */
  dueAt: number
}

export interface RecoveryStatus {
  offer: RecoveryOffer | null
  run: {
    id: string
    block: RateLimitBlock
    state: OccurrenceState
    dueAt: number
    hold?: OccurrenceHold
    reason?: string
    command?: CommandReceipt
  } | null
  support: ExecutionGrant["source"]
  message: string
}

/** Invalid, past and unreasonably distant dates never enable automatic work. */
export function recoveryDueAt(block: RateLimitBlock | null, now = Date.now()): number | null {
  if (block?.resetsAt === null || block?.resetsAt === undefined || !Number.isFinite(block.resetsAt)) return null
  const dueAt = block.resetsAt * 1000
  return Number.isSafeInteger(dueAt) && dueAt > now && dueAt - now <= 31 * 24 * 60 * 60_000 ? dueAt : null
}
