import { linkAsyncAnswers } from "../../shared/session/asyncAnswers"
import { getUserMessageText } from "../../shared/session/parser"
import { pairAgentMessageReplies } from "../../shared/session/turnBuilder"
import type { Turn } from "../../shared/session/types"
import type { AgentKind } from "@/lib/agents"

/**
 * Pure logic for paging older history into the timeline, kept out of the
 * components so boundary-turn stitching is unit-testable without a DOM.
 */

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

/**
 * Whether the newest list's first turn is the tail half of a turn some
 * byte-boundary read cut in two, and so belongs to the last older turn.
 *
 * Claude turns always open with a user message, so a null-userMessage head is
 * reliably a cut point. Codex turns legitimately have no user message, so its
 * parser marks the halves it could not see the start of instead.
 */
function isCutFragment(head: Turn, agentKind?: AgentKind): boolean {
  if (agentKind && agentKind !== "claude") return head.isFragment === true
  return head.userMessage === null
}

/** Image tags in a prompt record, and the attachment links the parser appends to an echo. */
const ATTACHMENT_FRAMING = /<image\b[^>]*>[\s\S]*?<\/image>|!\[image\]\(<[^>]*>\)|\[audio attachment\]\(<[^>]*>\)/g

function promptBody(text: string): string {
  return text.replace(ATTACHMENT_FRAMING, "").trim()
}

/**
 * Drops the steered prompt the older page ends on when the newer page opens on
 * its echo. A CLI that echoes a steer as a later prompt record would otherwise
 * show it twice when a page cut falls between the two. Only a page that opened
 * on a bare prompt record can hold such an echo, and the two copies frame
 * attachments differently, so they are compared without that framing.
 */
function dropSeamEcho(older: Turn[], head: Turn | undefined): Turn[] {
  const last = older[older.length - 1]
  const block = last?.contentBlocks[last.contentBlocks.length - 1]
  if (!head?.opensOnPrompt || block?.kind !== "queued_prompt") return older
  const prompt = promptBody(block.content)
  if (!prompt || prompt !== promptBody(getUserMessageText(head.userMessage))) return older
  return [...older.slice(0, -1), { ...last, contentBlocks: last.contentBlocks.slice(0, -1) }]
}

/**
 * How far apart the two copies of one message can be stamped. Across every peer
 * message on disk, 4 of the 6 enqueue/attachment pairs agree to the millisecond
 * and the other 2 drift by 1ms — the attachment inherits the enqueue's
 * timestamp. A second leaves three orders of magnitude of headroom and is still
 * 880x under the closest pair of genuinely distinct messages one agent has sent
 * (14m40s, `csp-and-proxy` in `…honest-cms/ddb6fc34…`).
 */
const DUPLICATE_WINDOW_MS = 1000

/**
 * Drops the second copy of a peer message.
 *
 * Claude Code persists each one twice — a `queue-operation` enqueue carrying
 * the raw envelope, then an `attachment` carrying the same text pre-stripped.
 * `buildTurns` reconciles the pair through a ledger scoped to its own call, so
 * a page boundary between the two copies leaves both standing, and dedup by
 * turn id cannot see it because they sit in different turns.
 *
 * The key is (sender, body) *and* proximity in time. Not the sender's task id:
 * that names the sending agent's task, so one agent's question and its later
 * done-report share it. Not (sender, body) alone: that spans the whole
 * transcript, so an agent that genuinely said the same thing twice collapsed to
 * one card, and the session then rendered differently depending on how it was
 * paged in. And not adjacency across the join, because the copies are not
 * adjacent: in `…ddb6fc34…` the two halves of one message are 306 records apart
 * with an unrelated message's enqueue sitting between them. Only the timestamps
 * stay tied to the message.
 *
 * A block with no parseable timestamp cannot be shown to be a duplicate, so it
 * is kept — dropping is the destructive direction.
 */
function dedupeAgentMessages(turns: readonly Turn[]): Turn[] {
  const lastKeptAt = new Map<string, number>()
  return turns.map((turn) => {
    if (!turn.contentBlocks.some((b) => b.kind === "agent_message")) return turn
    const kept = turn.contentBlocks.filter((block) => {
      if (block.kind !== "agent_message") return true
      const at = Date.parse(block.timestamp ?? "")
      if (Number.isNaN(at)) return true
      const key = `${block.sender}\u0000${block.body}`
      const previous = lastKeptAt.get(key)
      if (previous !== undefined && Math.abs(at - previous) <= DUPLICATE_WINDOW_MS) return false
      lastKeptAt.set(key, at)
      return true
    })
    return kept.length === turn.contentBlocks.length ? turn : { ...turn, contentBlocks: kept }
  })
}

/**
 * Prepends older turns onto the existing list, deduplicating by turn id and
 * stitching a turn that a byte-boundary read cut in half. `stitch` is false
 * when the boundary is known to fall between whole turns, where a head without
 * a prompt (a compaction's turn) is a turn of its own, not a cut half.
 *
 * Merging collapses the two halves into one row instead of leaving a promptless
 * fragment stranded at the top of the page.
 *
 * Each page arrives from its own `parseSession` call, so whatever `buildTurns`
 * reconciles within one page has to be re-run over the join: the duplicate copy
 * of a peer message, the pairing between a message and the `SendMessage` that
 * answered it, and between an async question and the reader's reply. Without
 * that, a message answered seconds later reads "Never answered" purely because
 * the pages happened to split between them.
 */
export function prependTurns(
  existing: Turn[],
  older: readonly Turn[],
  agentKind?: AgentKind,
  { stitch = true }: { stitch?: boolean } = {},
): Turn[] {
  const existingIds = new Set(existing.map((t) => t.id))
  const fresh = older.filter((t) => !existingIds.has(t.id))
  // Returns the input array unchanged when there is nothing to prepend, so
  // callers can detect no-ops by reference.
  if (fresh.length === 0) return existing
  const unique = dropSeamEcho(fresh, existing[0])

  const head = existing[0]
  const lastOlder = unique[unique.length - 1]
  const merged = stitch && head && lastOlder && isCutFragment(head, agentKind)
    ? [...unique.slice(0, -1), mergeTurnFragments(lastOlder, head), ...existing.slice(1)]
    : [...unique, ...existing]

  return linkAsyncAnswers(pairAgentMessageReplies(dedupeAgentMessages(merged)))
}

/**
 * Spans the merged turn from where the older fragment started to where the
 * newer one ended. Each fragment only timed its own slice, so taking either
 * one's duration reports a fraction of the turn.
 *
 * Two timed fragments are the exception: a turn a background task resumed is
 * cut where it was already idle, so spanning it would bill the wait as work.
 */
function mergedDuration(older: Turn, newer: Turn): number | null {
  if (older.durationMs !== null && newer.durationMs !== null) {
    return older.durationMs + newer.durationMs
  }
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
    compactionMeta: older.compactionMeta ?? newer.compactionMeta,
  }
}
