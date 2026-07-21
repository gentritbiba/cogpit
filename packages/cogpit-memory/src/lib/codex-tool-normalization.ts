// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
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

function extractCustomToolOutputText(output: unknown): string {
  if (typeof output === "string") return output
  if (!Array.isArray(output)) return ""
  return output
    .filter((block): block is Record<string, unknown> => isObject(block) && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
}

/** Parse Codex custom_tool_call output JSON or structured content blocks. */
export function parseCustomToolOutput(output: unknown): { text: string; isError: boolean } {
  const rawOutput = extractCustomToolOutputText(output)
  if (!rawOutput) return { text: "", isError: false }
  try {
    const parsed = JSON.parse(rawOutput) as Record<string, unknown>
    const text = typeof parsed.output === "string" ? parsed.output : rawOutput
    const meta = isObject(parsed.metadata) ? parsed.metadata : null
    const isError = meta ? (meta.exit_code !== 0 && meta.exit_code !== undefined) : inferToolError(text)
    return { text, isError }
  } catch {
    return { text: rawOutput, isError: inferToolError(rawOutput) }
  }
}
