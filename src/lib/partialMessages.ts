import type {
  PartialAssistantMessage,
  PartialContentBlock,
  StreamEventSSE,
} from "@/lib/types"

/**
 * Pure reducer: apply one SSE stream event to the partial-messages map and
 * return the next map. Returns the SAME reference when nothing changes so
 * callers can skip re-renders cheaply.
 *
 * Event semantics:
 *   - message_start         → create empty partial, track as "current"
 *   - content_block_start   → seed an empty block at `index`
 *   - content_block_delta   → append text/thinking/json to block at `index`
 *   - content_block_stop    → no-op (block already sealed by future deltas)
 *   - message_stop          → mark the most recently started partial stopped
 *   - anything else         → no-op
 */
export function applyStreamEvent(
  map: Map<string, PartialAssistantMessage>,
  payload: StreamEventSSE,
): Map<string, PartialAssistantMessage> {
  const ev = payload.event

  if (ev.type === "message_start" && ev.message?.id) {
    const next = new Map(map)
    next.set(ev.message.id, {
      messageId: ev.message.id,
      blocks: new Map(),
      stopped: false,
    })
    return next
  }

  // For block-level events we target the most recently started partial.
  const currentId = mostRecentId(map)
  if (!currentId) return map
  const current = map.get(currentId)
  if (!current) return map

  if (ev.type === "content_block_start" && typeof ev.index === "number") {
    const block = seedBlock(ev.content_block)
    if (!block) return map
    const nextBlocks = new Map(current.blocks)
    nextBlocks.set(ev.index, block)
    return replaceCurrent(map, currentId, { ...current, blocks: nextBlocks })
  }

  if (ev.type === "content_block_delta" && typeof ev.index === "number" && ev.delta) {
    const block = current.blocks.get(ev.index)
    const updated = applyDelta(block, ev.delta)
    if (!updated || updated === block) return map
    const nextBlocks = new Map(current.blocks)
    nextBlocks.set(ev.index, updated)
    return replaceCurrent(map, currentId, { ...current, blocks: nextBlocks })
  }

  if (ev.type === "message_stop") {
    if (current.stopped) return map
    return replaceCurrent(map, currentId, { ...current, stopped: true })
  }

  return map
}

/**
 * Drop the given message ids from the map. Used to discard partials once the
 * canonical assistant message arrives via JSONL tail.
 */
export function dropByMessageIds(
  map: Map<string, PartialAssistantMessage>,
  ids: Set<string>,
): Map<string, PartialAssistantMessage> {
  let changed = false
  for (const id of ids) {
    if (map.has(id)) {
      changed = true
      break
    }
  }
  if (!changed) return map
  const next = new Map(map)
  for (const id of ids) next.delete(id)
  return next
}

// ── Internals ────────────────────────────────────────────────────────────

function mostRecentId(map: Map<string, PartialAssistantMessage>): string | null {
  let last: string | null = null
  for (const id of map.keys()) last = id // Map preserves insertion order
  return last
}

function replaceCurrent(
  map: Map<string, PartialAssistantMessage>,
  id: string,
  next: PartialAssistantMessage,
): Map<string, PartialAssistantMessage> {
  const out = new Map(map)
  out.set(id, next)
  return out
}

function seedBlock(
  cb: StreamEventSSE["event"]["content_block"],
): PartialContentBlock | null {
  if (!cb) return null
  if (cb.type === "text") return { type: "text", text: "" }
  if (cb.type === "thinking") return { type: "thinking", text: "" }
  if (cb.type === "tool_use" && cb.id && cb.name) {
    return { type: "tool_use", id: cb.id, name: cb.name, partialInputJson: "" }
  }
  return null
}

function applyDelta(
  block: PartialContentBlock | undefined,
  delta: NonNullable<StreamEventSSE["event"]["delta"]>,
): PartialContentBlock | null {
  if (!block) return null
  if (delta.type === "text_delta" && block.type === "text" && delta.text !== undefined) {
    return { ...block, text: block.text + delta.text }
  }
  if (
    delta.type === "thinking_delta" &&
    block.type === "thinking" &&
    delta.thinking !== undefined
  ) {
    return { ...block, text: block.text + delta.thinking }
  }
  if (
    delta.type === "input_json_delta" &&
    block.type === "tool_use" &&
    delta.partial_json !== undefined
  ) {
    return { ...block, partialInputJson: block.partialInputJson + delta.partial_json }
  }
  // signature_delta and any other unknown delta types are ignored (no UI impact).
  return block
}
