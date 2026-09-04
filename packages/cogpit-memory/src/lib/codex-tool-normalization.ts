// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
import type { ImageBlock } from "./types"

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Every spelling of a Codex collaboration tool seen in rollouts, mapped to its
 * canonical name: the snake_case name itself, plus the camelCase form older
 * rollouts emitted.
 */
const COLLABORATION_TOOL_NAMES = new Map([
  ["spawn_agent", "spawn_agent"],
  ["spawnAgent", "spawn_agent"],
  ["wait_agent", "wait_agent"],
  ["waitAgent", "wait_agent"],
  ["send_message", "send_message"],
  ["sendMessage", "send_message"],
  ["followup_task", "followup_task"],
  ["followupTask", "followup_task"],
  ["list_agents", "list_agents"],
  ["listAgents", "list_agents"],
  ["interrupt_agent", "interrupt_agent"],
  ["interruptAgent", "interrupt_agent"],
])

const NATIVE_TOOL_NAMES = new Set([
  "exec", "exec_command", "write_stdin", "apply_patch", "update_plan",
  "view_image", "request_user_input", "request_user_input_async", "tool_search",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "request_plugin_install", "create_goal", "get_goal", "update_goal", "wait",
])

/**
 * Normalize a Codex function name to its canonical collaboration-tool name.
 * Current collaboration tools carry a namespace separately, but older and
 * transitional rollouts also encoded it in the function name itself.
 */
export function normalizeFunctionName(rawName: string): string {
  if (rawName.startsWith("mcp__")) return rawName
  const leaf = rawName
    .split(/(?:__|[.:/])+/)
    .filter(Boolean)
    .at(-1) ?? rawName

  return COLLABORATION_TOOL_NAMES.get(leaf) ?? (NATIVE_TOOL_NAMES.has(leaf) ? leaf : rawName)
}

export function inferToolError(output: string | null): boolean {
  if (!output) return false
  const exitMatch = output.match(/Process exited with code (\d+)/)
  if (exitMatch) return exitMatch[1] !== "0"
  const withoutSuccessSummaries = output
    .replace(/\b0\s+(?:fail(?:ed|ures?)?|errors?)\b/gi, "")
    .replace(/\bno\s+(?:failures?|errors?)\b/gi, "")
  return /\b(error|failed|exception)\b/i.test(withoutSuccessSummaries)
}

/** Normalize Codex update_plan input to TodoWrite format. */
export function normalizePlanToTodos(input: Record<string, unknown>): Record<string, unknown> {
  const plan = Array.isArray(input.plan) ? input.plan : []
  const todos = plan
    .filter((item): item is Record<string, unknown> => isObject(item))
    .map((item) => ({
      content: typeof item.step === "string" ? item.step : "",
      status: typeof item.status === "string" ? item.status : "pending",
      activeForm: typeof item.step === "string" ? item.step : "",
    }))
  return { todos }
}

export interface CodexToolOutput {
  text: string
  isError: boolean
  images?: ImageBlock[]
}

function outputImage(block: Record<string, unknown>): ImageBlock | null {
  if (block.type !== "image" && block.type !== "input_image" && block.type !== "image_url") return null
  const source = isObject(block.source) ? block.source : block
  const mediaType = source.media_type ?? source.mimeType
  if (typeof mediaType === "string" && mediaType.startsWith("image/") && typeof source.data === "string" && source.data) {
    return { type: "image", source: { type: "base64", media_type: mediaType, data: source.data } }
  }
  const url = isObject(block.image_url) ? block.image_url.url : block.image_url
  const match = typeof url === "string" ? /^data:(image\/[^;,]+);base64,(.+)$/is.exec(url) : null
  return match
    ? { type: "image", source: { type: "base64", media_type: match[1].toLowerCase(), data: match[2] } }
    : null
}

function outputContent(output: unknown): { text: string; images: ImageBlock[] } {
  if (typeof output === "string") return { text: output, images: [] }
  if (!Array.isArray(output)) {
    return { text: output == null ? "" : JSON.stringify(output), images: [] }
  }
  const text: string[] = []
  const images: ImageBlock[] = []
  for (const block of output) {
    if (!isObject(block)) continue
    if (typeof block.text === "string") text.push(block.text)
    const image = outputImage(block)
    if (image) images.push(image)
  }
  return { text: text.join(""), images }
}

/** Read function, custom-tool, and MCP output without losing structured images. */
export function parseCustomToolOutput(output: unknown): CodexToolOutput {
  const original = outputContent(output)
  let envelope: Record<string, unknown> | null = isObject(output) && !Array.isArray(output) ? output : null
  try {
    const parsed: unknown = envelope ?? JSON.parse(original.text)
    if (isObject(parsed) && !Array.isArray(parsed)) envelope = parsed
  } catch { /* Plain text output. */ }

  const content = envelope && ("output" in envelope || "content" in envelope)
    ? outputContent(envelope.output ?? envelope.content)
    : original
  const images = content === original ? original.images : [...original.images, ...content.images]
  const metadata = isObject(envelope?.metadata) ? envelope.metadata : null
  const exitCode = metadata?.exit_code ?? envelope?.exit_code
  const explicitError = typeof envelope?.isError === "boolean"
    ? envelope.isError
    : typeof envelope?.is_error === "boolean" ? envelope.is_error : undefined
  const isError = explicitError === true
    || (typeof exitCode === "number" ? exitCode !== 0 : explicitError ?? inferToolError(content.text))
  return {
    text: content.text,
    isError,
    ...(images.length > 0 ? { images } : {}),
  }
}
