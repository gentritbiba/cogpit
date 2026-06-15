/**
 * Ephemeral streaming overlay — pure state helpers.
 *
 * Holds in-flight (token-streamed) assistant messages received over the
 * session SSE channel from the server's stream bus. The overlay rides on
 * top of the parsed session: it renders inside the running turn and is
 * reconciled away as the complete JSONL lines arrive through the normal
 * pipeline, so streamed text never enters ParsedSession and never renders
 * twice.
 *
 * All functions are pure: they return a NEW array when something changed
 * and the SAME reference when nothing did (cheap React re-render gating).
 */

// ── Types (must mirror server/lib/streamBus.ts wire shapes) ──────────

export type OverlayBlockType = "text" | "thinking" | "tool_use"

export interface OverlayBlock {
  index: number
  blockType: OverlayBlockType
  toolName?: string
  text: string
}

export interface OverlayMessage {
  messageId: string
  /** null = main thread; otherwise the Task/Agent tool_use id it belongs to */
  parentToolUseId: string | null
  stopped: boolean
  /** Set when the message_stop marker arrived — used by the stale sweep */
  stoppedAt?: number
  blocks: OverlayBlock[]
}

export type StreamingOverlay = OverlayMessage[]

export interface StreamDeltaEvent {
  messageId: string
  parentToolUseId: string | null
  blockIndex: number
  blockType: OverlayBlockType
  toolName?: string
  delta: string
  event?: "block_start" | "message_stop"
}

export const EMPTY_OVERLAY: StreamingOverlay = []

// ── Builders ─────────────────────────────────────────────────────────

/** Replace the overlay wholesale from a server snapshot (connect/reconnect). */
export function applySnapshot(
  messages: Array<{
    messageId: string
    parentToolUseId: string | null
    stopped: boolean
    blocks: Array<{ index: number; blockType: OverlayBlockType; toolName?: string; text: string }>
  }>,
): StreamingOverlay {
  return messages.map((m) => ({
    messageId: m.messageId,
    parentToolUseId: m.parentToolUseId,
    stopped: m.stopped,
    ...(m.stopped ? { stoppedAt: Date.now() } : {}),
    blocks: m.blocks.map((b) => ({ ...b })),
  }))
}

/** Apply a batch of deltas. Returns a new array (the batch always changes something visible). */
export function applyDeltas(
  overlay: StreamingOverlay,
  events: StreamDeltaEvent[],
): StreamingOverlay {
  if (events.length === 0) return overlay

  // Shallow-copy top level; copy-on-write messages we touch.
  const next = overlay.slice()
  const touched = new Map<string, OverlayMessage>()

  const getMessage = (ev: StreamDeltaEvent): OverlayMessage => {
    let msg = touched.get(ev.messageId)
    if (msg) return msg
    const idx = next.findIndex((m) => m.messageId === ev.messageId)
    if (idx >= 0) {
      msg = { ...next[idx], blocks: next[idx].blocks.map((b) => ({ ...b })) }
      next[idx] = msg
    } else {
      msg = {
        messageId: ev.messageId,
        parentToolUseId: ev.parentToolUseId,
        stopped: false,
        blocks: [],
      }
      next.push(msg)
    }
    touched.set(ev.messageId, msg)
    return msg
  }

  for (const ev of events) {
    const msg = getMessage(ev)

    if (ev.event === "message_stop") {
      msg.stopped = true
      msg.stoppedAt = Date.now()
      continue
    }

    let block = msg.blocks.find((b) => b.index === ev.blockIndex)
    if (!block) {
      block = {
        index: ev.blockIndex,
        blockType: ev.blockType,
        ...(ev.toolName ? { toolName: ev.toolName } : {}),
        text: "",
      }
      msg.blocks.push(block)
    }
    if (ev.delta) block.text += ev.delta
  }

  return next
}

// ── Reconciliation ───────────────────────────────────────────────────

const MSG_ID_RE = /"id"\s*:\s*"(msg_[A-Za-z0-9]+)"/g

/**
 * Drop MAIN-THREAD overlay messages whose complete JSONL line has arrived.
 * Matches the API message id (`msg_…`) with a regex over the RAW line
 * strings — no JSON.parse on the main thread, works on multi-MB lines.
 *
 * Subagent messages (parentToolUseId set) are deliberately NOT reconciled:
 * they form the live transcript tail and must persist while the agent runs
 * (their agent_progress JSONL lines land within ~500 ms, which would
 * otherwise flash-remove them). They are wiped by stream_clear at turn end.
 *
 * Returns the SAME reference when nothing matched.
 */
export function reconcileWithLines(
  overlay: StreamingOverlay,
  lines: string[],
): StreamingOverlay {
  if (overlay.length === 0 || lines.length === 0) return overlay

  const landedIds = new Set<string>()
  for (const line of lines) {
    MSG_ID_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = MSG_ID_RE.exec(line)) !== null) {
      landedIds.add(match[1])
    }
  }
  if (landedIds.size === 0) return overlay

  const next = overlay.filter(
    (m) => m.parentToolUseId !== null || !landedIds.has(m.messageId),
  )
  return next.length === overlay.length ? overlay : next
}

/**
 * Drop stopped MAIN-THREAD messages whose JSONL line never matched within
 * `maxAgeMs` (e.g. the line was filtered or the id differs). Subagent
 * messages persist for the live transcript until stream_clear. Returns the
 * SAME reference when nothing was dropped.
 */
export function sweepStale(
  overlay: StreamingOverlay,
  maxAgeMs = 10_000,
  now = Date.now(),
): StreamingOverlay {
  if (overlay.length === 0) return overlay
  const next = overlay.filter(
    (m) =>
      m.parentToolUseId !== null ||
      !(m.stopped && m.stoppedAt !== undefined && now - m.stoppedAt > maxAgeMs),
  )
  return next.length === overlay.length ? overlay : next
}

// ── Selectors ────────────────────────────────────────────────────────

/** Main-thread messages (rendered in the running turn). */
export function mainThreadMessages(overlay: StreamingOverlay): OverlayMessage[] {
  return overlay.filter((m) => m.parentToolUseId === null)
}

/** Messages belonging to one Task/Agent tool call (rendered in its card). */
export function messagesForToolUse(
  overlay: StreamingOverlay,
  toolUseId: string,
): OverlayMessage[] {
  return overlay.filter((m) => m.parentToolUseId === toolUseId)
}
