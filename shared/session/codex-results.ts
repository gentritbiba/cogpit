// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Result projection for Codex records: a tool call's output, kept in its
 * envelope so the exit status and images the parser reads from it survive,
 * and the output copies of `exec_command_end` events no reader parses.
 */
import { parseCustomToolOutput } from "./codex-tool-normalization"
import { isPlainObject, visitField, visitJoinedText, type ResultVisitor } from "./resultProjection"

const OUTPUT_ITEMS = new Set(["function_call_output", "custom_tool_call_output"])
const EXEC_OUTPUT_KEYS = ["aggregated_output", "formatted_output", "stdout", "stderr"]

/** What the parser reads from an output besides its text; a projection must not change it. */
function semantics(output: unknown): string {
  const parsed = parseCustomToolOutput(output)
  return JSON.stringify([parsed.isError, parsed.images?.length ?? 0])
}

function visitImage(block: Record<string, unknown>, visit: ResultVisitor): Record<string, unknown> {
  const source = isPlainObject(block.source) ? { ...block.source } : null
  if (source) return visitField(source, "data", visit, "image") ? { ...block, source } : block
  if (typeof block.image_url !== "string") return block
  const match = /^(data:image\/[^;,]+;base64,)(.+)$/is.exec(block.image_url)
  if (!match) return block
  const next = visit(match[2]!, "image")
  return next === match[2] ? block : { ...block, image_url: match[1] + next }
}

/** A block array as the parser reads it: its text parts joined without a separator into one body, its images one by one. */
function projectBlocks(blocks: readonly unknown[], visit: ResultVisitor): unknown[] {
  const joined = visitJoinedText(blocks, (block) => isPlainObject(block) && typeof block.text === "string" ? block.text : undefined, "", (block, text) => ({ ...(block as object), text }), visit) ?? blocks
  let changed = joined !== blocks
  const next = joined.map((block) => {
    if (!isPlainObject(block) || typeof block.text === "string") return block
    const projected = visitImage(block, visit)
    if (projected !== block) changed = true
    return projected
  })
  return changed ? next : blocks as unknown[]
}

/** An output value with its bodies elided: a block array, a JSON envelope around text or blocks, or plain text. */
function projectValue(output: unknown, visit: ResultVisitor): unknown {
  if (Array.isArray(output)) return projectBlocks(output, visit)
  if (typeof output !== "string") return output
  let envelope: unknown = null
  try { envelope = JSON.parse(output) } catch { /* Plain text. */ }
  if (isPlainObject(envelope) && ("output" in envelope || "content" in envelope)) {
    const key = envelope.output !== undefined && envelope.output !== null ? "output" : "content"
    const inner = envelope[key]
    const projected = typeof inner === "string" ? visit(inner, "text") : Array.isArray(inner) ? projectValue(inner, visit) : inner
    return projected === inner ? output : JSON.stringify({ ...envelope, [key]: projected })
  }
  return visit(output, "text")
}

/**
 * Projects a tool output whatever its shape, then keeps the projection only
 * when the parser reads the same failure and images from it as from the
 * native output; otherwise the output travels whole.
 */
function projectOutput(payload: Record<string, unknown>, visit: ResultVisitor): boolean {
  const output = payload.output
  const next = projectValue(output, visit)
  if (next === output || semantics(next) !== semantics(output)) return false
  payload.output = next
  return true
}

export function projectCodexResults(record: Record<string, unknown>, visit: ResultVisitor): boolean {
  const payload = isPlainObject(record.payload) ? record.payload : null
  if (!payload) return false
  if (record.type === "response_item" && OUTPUT_ITEMS.has(String(payload.type))) return projectOutput(payload, visit)
  if (record.type === "event_msg" && payload.type === "exec_command_end") {
    let changed = false
    for (const key of EXEC_OUTPUT_KEYS) changed = visitField(payload, key, visit) || changed
    return changed
  }
  return false
}
