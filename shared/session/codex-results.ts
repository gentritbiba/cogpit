// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Result projection for Codex records: a tool call's output, kept in its
 * envelope so the exit status and images the parser reads from it survive,
 * and the output copies of `exec_command_end` events no reader parses.
 */
import { parseCustomToolOutput } from "./codex-tool-normalization"
import { isPlainObject, visitField, type ResultVisitor } from "./resultProjection"

const OUTPUT_ITEMS = new Set(["function_call_output", "custom_tool_call_output"])
const EXEC_OUTPUT_KEYS = ["aggregated_output", "formatted_output", "stdout", "stderr"]

/** What the parser reads from an output besides its text; a projection must not change it. */
function semantics(output: unknown): string {
  const parsed = parseCustomToolOutput(output)
  return JSON.stringify([parsed.isError, parsed.images?.length ?? 0])
}

function visitImage(block: Record<string, unknown>, visit: ResultVisitor): boolean {
  const source = isPlainObject(block.source) ? block.source : null
  if (source) return visitField(source, "data", visit, "image")
  if (typeof block.image_url !== "string") return false
  const match = /^(data:image\/[^;,]+;base64,)(.+)$/is.exec(block.image_url)
  if (!match) return false
  const next = visit(match[2], "image")
  if (next === match[2]) return false
  block.image_url = match[1] + next
  return true
}

function visitBlocks(blocks: unknown[], visit: ResultVisitor): boolean {
  let changed = false
  for (const block of blocks) {
    if (!isPlainObject(block)) continue
    if (typeof block.text === "string") changed = visitField(block, "text", visit) || changed
    else changed = visitImage(block, visit) || changed
  }
  return changed
}

/** Projects a tool output string: its envelope's text when it has one, else the string itself. */
function projectOutput(payload: Record<string, unknown>, visit: ResultVisitor): boolean {
  const output = payload.output
  if (Array.isArray(output)) return visitBlocks(output, visit)
  if (typeof output !== "string") return false
  const expected = semantics(output)
  let envelope: unknown = null
  try { envelope = JSON.parse(output) } catch { /* Plain text. */ }
  if (isPlainObject(envelope) && ("output" in envelope || "content" in envelope)) {
    const key = "output" in envelope ? "output" : "content"
    const inner = envelope[key]
    const keeps = (replacement: string) => semantics(JSON.stringify({ ...envelope as object, [key]: replacement })) === expected
    const changed = typeof inner === "string" ? visitField(envelope, key, visit, "text", keeps) : Array.isArray(inner) && visitBlocks(inner, visit)
    if (changed) payload.output = JSON.stringify(envelope)
    return changed
  }
  return visitField(payload, "output", visit, "text", (replacement) => semantics(replacement) === expected)
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
