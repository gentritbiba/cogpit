import type { Turn } from "@/lib/types"

/**
 * Pure logic for timeline infinite scrolling. Kept out of the components so
 * the tricky parts (prepend detection, boundary-turn stitching, trigger
 * distance) are unit-testable without a DOM.
 */

/** Load older content while the viewport top is within this many viewport-heights of the content top. */
export const NEAR_TOP_VIEWPORTS = 1.5

/** True when the scroll position is close enough to the top to page in older turns. */
export function isNearTop(scrollTop: number, clientHeight: number): boolean {
  if (clientHeight <= 0) return false
  return scrollTop < clientHeight * NEAR_TOP_VIEWPORTS
}

export interface TimelineSnapshot {
  firstKey: string | undefined
  length: number
}

/**
 * Detects whether the current render is a prepend (older turns inserted at the
 * front) relative to the previous committed render. Drives virtua's `shift`
 * prop so scroll position is preserved from the end during prepends.
 */
export function isPrepend(prev: TimelineSnapshot | null, keys: readonly string[]): boolean {
  if (!prev || !prev.firstKey || keys.length <= prev.length) return false
  if (keys[0] === prev.firstKey) return false
  return keys.includes(prev.firstKey)
}

/**
 * Prepends older turns onto the existing list, deduplicating by turn id and
 * stitching a turn that a byte-boundary read cut in half.
 *
 * A tail (or older page) that starts mid-turn parses its first fragment with
 * `userMessage: null` and a synthetic id. For Claude sessions a full parse
 * never produces such a turn mid-file (assistant records always attach to the
 * current turn), so a null-userMessage head is reliably a cut point: merge it
 * into the last older turn, which restores the turn id a full parse would
 * have produced. Codex turns legitimately have null userMessage, so they are
 * never stitched.
 */
export function prependTurns(
  existing: Turn[],
  older: readonly Turn[],
  agentKind?: "claude" | "codex",
): Turn[] {
  const existingIds = new Set(existing.map((t) => t.id))
  const unique = older.filter((t) => !existingIds.has(t.id))
  // Returns the input array unchanged when there is nothing to prepend, so
  // callers can detect no-ops by reference.
  if (unique.length === 0) return existing

  const head = existing[0]
  const lastOlder = unique[unique.length - 1]
  if (agentKind !== "codex" && head && head.userMessage === null && lastOlder) {
    return [...unique.slice(0, -1), mergeTurnFragments(lastOlder, head), ...existing.slice(1)]
  }
  return [...unique, ...existing]
}

/**
 * Merges the newer fragment of a byte-boundary-cut turn into its older
 * fragment. The merged turn keeps the NEWER fragment's id: that id is already
 * on screen, so keeping it stable means React reuses the existing row (its
 * expansion state survives) and prepend detection keeps seeing the first key.
 */
function mergeTurnFragments(older: Turn, newer: Turn): Turn {
  return {
    ...older,
    id: newer.id,
    contentBlocks: [...older.contentBlocks, ...newer.contentBlocks],
    thinking: [...older.thinking, ...newer.thinking],
    assistantText: [...older.assistantText, ...newer.assistantText],
    toolCalls: [...older.toolCalls, ...newer.toolCalls],
    subAgentActivity: [...older.subAgentActivity, ...newer.subAgentActivity],
    durationMs: newer.durationMs ?? older.durationMs,
    tokenUsage: newer.tokenUsage ?? older.tokenUsage,
    model: newer.model ?? older.model,
    compactionSummary: older.compactionSummary ?? newer.compactionSummary,
  }
}
