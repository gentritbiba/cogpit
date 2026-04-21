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

// ── Rendering helpers ────────────────────────────────────────────────────

/**
 * One renderable block inside a partial assistant message. Preserves the
 * original block-index order so interleaved sequences like
 * `[text_0, thinking_1, text_2]` render in API order (rather than with all
 * thinking bucketed above all text).
 */
export interface PartialRenderBlock {
  kind: "text" | "thinking"
  text: string
}

/**
 * Lightweight render shape for in-flight partial assistant messages. The
 * timeline appends one of these to the end of the turn list until the
 * canonical assistant message arrives via JSONL (at which point the partial
 * is dropped by `dropByMessageIds` — see Task 7 reconciliation).
 *
 * tool_use partials are intentionally omitted from v1 rendering — only text
 * and thinking blocks stream character-by-character.
 *
 * `blocks` preserves the content_block index order so the UI renders
 * interleaved text/thinking chunks the same order the model produced them.
 */
export interface PartialRenderTurn {
  messageId: string
  blocks: PartialRenderBlock[]
}

/**
 * Convert the in-memory `partialMessages` map into a lightweight, render-ready
 * shape. Partials whose `messageId` already appears in `existingAssistantIds`
 * (because the canonical JSONL line has landed) are skipped so we never
 * double-render while reconciliation is in flight. Partials with no content
 * yet (e.g. only `message_start` has landed, no deltas) are also skipped so
 * we don't render a blank placeholder and hide the "no turns" empty state.
 *
 * Insertion order of the incoming Map is preserved; block order within each
 * partial follows the content_block `index` (i.e. the Map key) numerically.
 */
export function synthesizePartialTurns(
  partials: Map<string, PartialAssistantMessage>,
  existingAssistantIds: Set<string>,
): PartialRenderTurn[] {
  if (partials.size === 0) return []
  const out: PartialRenderTurn[] = []
  for (const partial of partials.values()) {
    if (existingAssistantIds.has(partial.messageId)) continue
    const blocks: PartialRenderBlock[] = []
    // Iterate in ascending index order so text/thinking render in the order
    // the API produced them (interleaved order is preserved).
    const indices = [...partial.blocks.keys()].sort((a, b) => a - b)
    for (const idx of indices) {
      const block = partial.blocks.get(idx)
      if (!block) continue
      if (block.type === "text") {
        if (block.text.length > 0) blocks.push({ kind: "text", text: block.text })
      } else if (block.type === "thinking") {
        if (block.text.length > 0) blocks.push({ kind: "thinking", text: block.text })
      }
      // tool_use blocks are intentionally skipped in v1.
    }
    // Skip partials with no renderable content — this avoids a brief blank
    // render window between `message_start` and the first delta (100–500ms).
    if (blocks.length === 0) continue
    out.push({ messageId: partial.messageId, blocks })
  }
  return out
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

/**
 * Return the id of the most recently started partial, or null if none.
 *
 * Assumes the Anthropic SSE stream is non-interleaved — i.e. `message_start`
 * / `message_stop` bracket each message and block-level events for different
 * messages are never interleaved on the same channel. This invariant holds
 * for the current SDK behavior (one stream per assistant turn). If subagent
 * streams ever land on the same emitter alongside parent streams, revisit
 * this (use `parent_tool_use_id` as a secondary key to route correctly).
 */
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
  if (delta.type === "text_delta" && block.type === "text" && delta.text) {
    return { ...block, text: block.text + delta.text }
  }
  if (delta.type === "thinking_delta" && block.type === "thinking" && delta.thinking) {
    return { ...block, text: block.text + delta.thinking }
  }
  if (
    delta.type === "input_json_delta" &&
    block.type === "tool_use" &&
    delta.partial_json
  ) {
    return { ...block, partialInputJson: block.partialInputJson + delta.partial_json }
  }
  // signature_delta and any other unknown delta types are ignored (no UI impact).
  return block
}
