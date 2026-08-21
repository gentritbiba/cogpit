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

/**
 * Whether the timeline should render its empty state instead of the list.
 *
 * An empty state renders no scroll content, so nothing is left to trigger a
 * scroll-up load. A window that happens to parse to zero turns — a byte-window
 * tail of nothing but tool results or metadata records — would therefore be
 * stranded on "No turns in this session" forever. While older pages remain,
 * keep the (empty) list mounted so paging chains until history arrives.
 */
export function shouldShowEmptyState(visibleTurnCount: number, hasMore: boolean): boolean {
  return visibleTurnCount === 0 && !hasMore
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
 * Whether the newest list's first turn is the tail half of a turn some
 * byte-boundary read cut in two, and so belongs to the last older turn.
 *
 * Claude turns always open with a user message, so a null-userMessage head is
 * reliably a cut point. Codex turns legitimately have no user message, so its
 * parser marks the halves it could not see the start of instead.
 */
function isCutFragment(head: Turn, agentKind?: "claude" | "codex"): boolean {
  if (agentKind === "codex") return head.isFragment === true
  return head.userMessage === null
}

/**
 * Prepends older turns onto the existing list, deduplicating by turn id and
 * stitching a turn that a byte-boundary read cut in half.
 *
 * Merging collapses the two halves into one row instead of leaving a promptless
 * fragment stranded at the top of the page.
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
  if (head && lastOlder && isCutFragment(head, agentKind)) {
    return [...unique.slice(0, -1), mergeTurnFragments(lastOlder, head), ...existing.slice(1)]
  }
  return [...unique, ...existing]
}

/**
 * Spans the merged turn from where the older fragment started to where the
 * newer one ended. Each fragment only timed its own slice, so taking either
 * one's duration reports a fraction of the turn.
 */
function mergedDuration(older: Turn, newer: Turn): number | null {
  const start = Date.parse(older.timestamp)
  const end = Date.parse(newer.timestamp) + (newer.durationMs ?? 0)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return newer.durationMs ?? older.durationMs
  }
  return end - start
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
    durationMs: mergedDuration(older, newer),
    tokenUsage: newer.tokenUsage ?? older.tokenUsage,
    model: newer.model ?? older.model,
    compactionSummary: older.compactionSummary ?? newer.compactionSummary,
  }
}
