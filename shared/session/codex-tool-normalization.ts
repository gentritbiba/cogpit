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

/**
 * Read the exit code Codex's shell wrapper prints into its own output. Nothing
 * else in the text decides failure: a command that prints source files, HTML or
 * logs carries words like "error" that say nothing about how it ended.
 */
export function hasFailedExit(output: string | null): boolean {
  const exitMatch = output?.match(/Process exited with code (\d+)/)
  return exitMatch ? exitMatch[1] !== "0" : false
}

/**
 * Names Codex gives the tool that asks the user a question, both the blocking
 * form and the `_async` one that returns a receipt and keeps working.
 */
export function isCodexQuestionTool(name: string): boolean {
  return name === "request_user_input" || name === "request_user_input_async"
}

/**
 * Normalize Codex request_user_input input to AskUserQuestion format.
 *
 * Codex writes a question as `{ title, options: string[] | null }`, where the
 * options are bare labels rather than the `{ label, description }` objects the
 * question card renders.
 */
export function normalizeQuestions(input: Record<string, unknown>): Record<string, unknown> {
  const source = Array.isArray(input.questions) ? input.questions : [input]
  const questions = source
    .filter((question): question is Record<string, unknown> => isObject(question))
    .map((question) => {
      const text = typeof question.question === "string"
        ? question.question
        : typeof question.title === "string" ? question.title : ""
      const options = Array.isArray(question.options) ? question.options : []
      return {
        question: text,
        ...(typeof question.header === "string" && question.header
          ? { header: question.header }
          : {}),
        options: options
          .map((option) => {
            if (typeof option === "string") return { label: option }
            if (!isObject(option) || typeof option.label !== "string") return null
            return {
              label: option.label,
              ...(typeof option.description === "string" && option.description
                ? { description: option.description }
                : {}),
            }
          })
          .filter((option): option is { label: string; description?: string } => option !== null),
      }
    })
    .filter((question) => question.question)

  return questions.length > 0 ? { ...input, questions } : input
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

function outputContent(output: unknown): { parts: string[]; text: string; images: ImageBlock[] } {
  if (typeof output === "string") return { parts: [output], text: output, images: [] }
  if (!Array.isArray(output)) {
    const text = output == null ? "" : JSON.stringify(output)
    return { parts: [text], text, images: [] }
  }
  const parts: string[] = []
  const images: ImageBlock[] = []
  for (const block of output) {
    if (!isObject(block)) continue
    if (typeof block.text === "string") parts.push(block.text)
    const image = outputImage(block)
    if (image) images.push(image)
  }
  return { parts, text: parts.join(""), images }
}

/** Codex opens every exec result with a status line, then one block per chunk. */
const SCRIPT_STATUS = /^Script (?:completed|failed|running)\b/

function collectExitCodes(chunk: unknown, codes: number[]): void {
  if (!isObject(chunk)) return
  if (chunk.status === "rejected") codes.push(1)
  else if (chunk.status === "fulfilled") collectExitCodes(chunk.value, codes)
  else if (typeof chunk.exit_code === "number") codes.push(chunk.exit_code)
}

/**
 * Read how an exec script ended. Codex runs each shell command as its own chunk
 * and serializes one envelope per chunk after the status line, so the result
 * never parses as a whole and its exit codes stay invisible to the caller.
 */
function scriptFailed(parts: readonly string[]): boolean | undefined {
  const status = parts[0] ?? ""
  if (!SCRIPT_STATUS.test(status)) return undefined
  if (status.startsWith("Script failed")) return true
  const codes: number[] = []
  for (const part of parts.slice(1)) {
    let chunk: unknown
    try { chunk = JSON.parse(part) } catch { continue }
    for (const entry of Array.isArray(chunk) ? chunk : [chunk]) collectExitCodes(entry, codes)
  }
  return codes.length > 0 ? codes.some((code) => code !== 0) : undefined
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
    || (typeof exitCode === "number"
      ? exitCode !== 0
      : explicitError ?? scriptFailed(original.parts) ?? hasFailedExit(content.text))
  return {
    text: content.text,
    isError,
    ...(images.length > 0 ? { images } : {}),
  }
}
