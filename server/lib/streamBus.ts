/**
 * In-memory stream bus: token-level streaming events from SDK-driven Claude
 * sessions, keyed by sessionId.
 *
 * `sdk-session.ts` publishes the SDK's raw Anthropic stream events here; the
 * `/api/watch/:dirName/:fileName` SSE route subscribes and forwards batches
 * to the client on the EventSource it already holds. External sessions
 * (started outside Cogpit) never publish, so subscribers see nothing and the
 * SSE behaves exactly as before.
 *
 * Lanes: events between `message_start` and `message_stop` belong to the
 * current message of their lane, where a lane is `parentToolUseId ?? "main"`.
 * This lets the main thread and several subagents stream concurrently.
 *
 * Reconciliation contract: the API message id (`msg_…`) from `message_start`
 * appears verbatim in the JSONL line Claude Code writes when the message
 * completes. `completeMessage()` is called at that moment, so a late
 * subscriber's snapshot never duplicates what the JSONL tail already serves.
 */

// ── Public types ─────────────────────────────────────────────────────

export type StreamBlockType = "text" | "thinking" | "tool_use"

export interface StreamDelta {
  messageId: string
  /** null = main thread; otherwise the Task/Agent tool_use id */
  parentToolUseId: string | null
  blockIndex: number
  blockType: StreamBlockType
  /** tool_use blocks only */
  toolName?: string
  /** accumulated text/thinking/partial_json chunk for this batch window */
  delta: string
  /** lifecycle markers; absent for plain content deltas */
  event?: "block_start" | "message_stop"
}

export interface StreamBlockState {
  index: number
  blockType: StreamBlockType
  toolName?: string
  text: string
}

export interface StreamMessageState {
  messageId: string
  parentToolUseId: string | null
  stopped: boolean
  blocks: StreamBlockState[]
}

export type StreamBusEvent =
  | { type: "stream_delta"; events: StreamDelta[] }
  | { type: "stream_clear" }

/**
 * Minimal structural type for the Anthropic raw stream events we consume —
 * avoids coupling this module to SDK type exports.
 */
export interface RawStreamEvent {
  type: string
  index?: number
  message?: { id?: string }
  content_block?: { type?: string; name?: string }
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
}

// ── Tuning ───────────────────────────────────────────────────────────

/** Batch window: leading flush, then at most one flush per window. */
const FLUSH_MS = 75
/** Per-block accumulated text cap (snapshot payload safety). */
const MAX_BLOCK_TEXT = 256 * 1024
/** Per-session in-flight message cap. */
const MAX_MESSAGES = 50

// ── Internal state ───────────────────────────────────────────────────

type Listener = (ev: StreamBusEvent) => void

interface SessionStreamState {
  /** laneKey (parentToolUseId ?? "main") → current in-flight messageId */
  lanes: Map<string, string>
  /** messageId → accumulated state (insertion-ordered) */
  messages: Map<string, StreamMessageState>
  pending: StreamDelta[]
  flushTimer: ReturnType<typeof setTimeout> | null
  listeners: Set<Listener>
}

const sessions = new Map<string, SessionStreamState>()

function getOrCreate(sessionId: string): SessionStreamState {
  let state = sessions.get(sessionId)
  if (!state) {
    state = { lanes: new Map(), messages: new Map(), pending: [], flushTimer: null, listeners: new Set() }
    sessions.set(sessionId, state)
  }
  return state
}

/** Drop the session entry once nothing references it. */
function maybeGc(sessionId: string, state: SessionStreamState): void {
  if (
    state.listeners.size === 0 &&
    state.messages.size === 0 &&
    state.lanes.size === 0 &&
    state.pending.length === 0
  ) {
    if (state.flushTimer) clearTimeout(state.flushTimer)
    sessions.delete(sessionId)
  }
}

function emit(state: SessionStreamState, ev: StreamBusEvent): void {
  for (const listener of state.listeners) {
    try {
      listener(ev)
    } catch {
      // a broken subscriber must not break the others
    }
  }
}

function flushPending(state: SessionStreamState): void {
  if (state.pending.length === 0) return
  const events = state.pending
  state.pending = []
  if (state.listeners.size > 0) {
    emit(state, { type: "stream_delta", events })
  }
}

/** Leading + trailing throttle: first event flushes immediately, the rest batch per window. */
function scheduleFlush(state: SessionStreamState): void {
  if (state.flushTimer) return // a trailing flush is already scheduled
  flushPending(state)
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null
    flushPending(state)
  }, FLUSH_MS)
}

function queueDelta(state: SessionStreamState, delta: StreamDelta): void {
  // Merge consecutive content deltas for the same block into one entry.
  const last = state.pending[state.pending.length - 1]
  if (
    last &&
    !last.event &&
    !delta.event &&
    last.messageId === delta.messageId &&
    last.blockIndex === delta.blockIndex
  ) {
    last.delta += delta.delta
  } else {
    state.pending.push(delta)
  }
  scheduleFlush(state)
}

function blockTypeOf(rawType: string | undefined): StreamBlockType | null {
  if (rawType === "text") return "text"
  if (rawType === "thinking") return "thinking"
  if (rawType === "tool_use") return "tool_use"
  return null
}

// ── Public API ───────────────────────────────────────────────────────

/** Feed one raw Anthropic stream event into the session's accumulated state. */
export function publish(
  sessionId: string,
  ev: RawStreamEvent,
  parentToolUseId: string | null,
): void {
  const state = getOrCreate(sessionId)
  const laneKey = parentToolUseId ?? "main"

  switch (ev.type) {
    case "message_start": {
      const messageId = ev.message?.id
      if (!messageId) return
      state.lanes.set(laneKey, messageId)
      state.messages.set(messageId, {
        messageId,
        parentToolUseId,
        stopped: false,
        blocks: [],
      })
      // Cap in-flight messages: drop oldest first
      while (state.messages.size > MAX_MESSAGES) {
        const oldest = state.messages.keys().next().value
        if (oldest === undefined) break
        state.messages.delete(oldest)
      }
      return
    }

    case "content_block_start": {
      const messageId = state.lanes.get(laneKey)
      const msg = messageId ? state.messages.get(messageId) : undefined
      if (!messageId || !msg || ev.index === undefined) return
      const blockType = blockTypeOf(ev.content_block?.type)
      if (!blockType) return
      const toolName = blockType === "tool_use" ? ev.content_block?.name : undefined
      msg.blocks.push({ index: ev.index, blockType, ...(toolName ? { toolName } : {}), text: "" })
      queueDelta(state, {
        messageId,
        parentToolUseId,
        blockIndex: ev.index,
        blockType,
        ...(toolName ? { toolName } : {}),
        delta: "",
        event: "block_start",
      })
      return
    }

    case "content_block_delta": {
      const messageId = state.lanes.get(laneKey)
      const msg = messageId ? state.messages.get(messageId) : undefined
      if (!messageId || !msg || ev.index === undefined) return
      const d = ev.delta
      const text =
        d?.type === "text_delta" ? d.text
        : d?.type === "thinking_delta" ? d.thinking
        : d?.type === "input_json_delta" ? d.partial_json
        : undefined
      if (!text) return
      let block = msg.blocks.find((b) => b.index === ev.index)
      if (!block) {
        // Robustness: a delta without a preceding block_start (e.g. snapshot
        // raced the subscriber). Infer the block type from the delta kind.
        const inferred: StreamBlockType =
          d?.type === "thinking_delta" ? "thinking"
          : d?.type === "input_json_delta" ? "tool_use"
          : "text"
        block = { index: ev.index, blockType: inferred, text: "" }
        msg.blocks.push(block)
      }
      if (block.text.length < MAX_BLOCK_TEXT) {
        block.text += text
      }
      queueDelta(state, {
        messageId,
        parentToolUseId,
        blockIndex: ev.index,
        blockType: block.blockType,
        ...(block.toolName ? { toolName: block.toolName } : {}),
        delta: text,
      })
      return
    }

    case "message_stop": {
      const messageId = state.lanes.get(laneKey)
      const msg = messageId ? state.messages.get(messageId) : undefined
      state.lanes.delete(laneKey)
      if (!messageId || !msg) return
      msg.stopped = true
      queueDelta(state, {
        messageId,
        parentToolUseId,
        blockIndex: -1,
        blockType: "text",
        delta: "",
        event: "message_stop",
      })
      return
    }

    default:
      // content_block_stop, message_delta, ping … nothing to surface
      return
  }
}

/**
 * Publish an already-complete message (no token stream available for it).
 *
 * Used for subagent messages: the SDK does not emit token-level stream
 * events for subagents — `forwardSubagentText` forwards each COMPLETE
 * message as the subagent produces it. Surfacing those here gives
 * message-granularity live transcripts. The entry reconciles away when the
 * matching agent_progress JSONL line lands (same message id) or via the
 * client's stale sweep.
 */
export function publishCompleteMessage(
  sessionId: string,
  msg: {
    messageId: string
    parentToolUseId: string | null
    blocks: Array<{ blockType: StreamBlockType; toolName?: string; text: string }>
  },
): void {
  const state = getOrCreate(sessionId)
  const blocks: StreamBlockState[] = msg.blocks.map((b, i) => ({
    index: i,
    blockType: b.blockType,
    ...(b.toolName ? { toolName: b.toolName } : {}),
    text: b.text.slice(0, MAX_BLOCK_TEXT),
  }))
  state.messages.set(msg.messageId, {
    messageId: msg.messageId,
    parentToolUseId: msg.parentToolUseId,
    stopped: true,
    blocks,
  })
  while (state.messages.size > MAX_MESSAGES) {
    const oldest = state.messages.keys().next().value
    if (oldest === undefined) break
    state.messages.delete(oldest)
  }
  for (const b of blocks) {
    queueDelta(state, {
      messageId: msg.messageId,
      parentToolUseId: msg.parentToolUseId,
      blockIndex: b.index,
      blockType: b.blockType,
      ...(b.toolName ? { toolName: b.toolName } : {}),
      delta: b.text,
    })
  }
  queueDelta(state, {
    messageId: msg.messageId,
    parentToolUseId: msg.parentToolUseId,
    blockIndex: -1,
    blockType: "text",
    delta: "",
    event: "message_stop",
  })
}

/**
 * Drop a message's accumulated state — its complete JSONL line now exists,
 * so the file tail (and any future snapshot) supersedes the stream copy.
 */
export function completeMessage(sessionId: string, messageId: string): void {
  const state = sessions.get(sessionId)
  if (!state) return
  state.messages.delete(messageId)
  for (const [lane, id] of state.lanes) {
    if (id === messageId) state.lanes.delete(lane)
  }
  maybeGc(sessionId, state)
}

/** Wipe a session's stream state (turn finished or errored) and tell subscribers. */
export function clear(sessionId: string): void {
  const state = sessions.get(sessionId)
  if (!state) return
  state.lanes.clear()
  state.messages.clear()
  state.pending = []
  if (state.flushTimer) {
    clearTimeout(state.flushTimer)
    state.flushTimer = null
  }
  emit(state, { type: "stream_clear" })
  maybeGc(sessionId, state)
}

/** Current in-flight messages for a late subscriber (mid-turn page load). */
export function getSnapshot(sessionId: string): StreamMessageState[] | null {
  const state = sessions.get(sessionId)
  if (!state || state.messages.size === 0) return null
  return Array.from(state.messages.values(), (m) => ({
    ...m,
    blocks: m.blocks.map((b) => ({ ...b })),
  }))
}

/** Subscribe to a session's stream events. Returns an unsubscribe function. */
export function subscribe(sessionId: string, listener: Listener): () => void {
  const state = getOrCreate(sessionId)
  state.listeners.add(listener)
  return () => {
    const current = sessions.get(sessionId)
    if (!current) return
    current.listeners.delete(listener)
    maybeGc(sessionId, current)
  }
}

/** Test helper: reset all bus state. */
export function _resetForTests(): void {
  for (const state of sessions.values()) {
    if (state.flushTimer) clearTimeout(state.flushTimer)
  }
  sessions.clear()
}
