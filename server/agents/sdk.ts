/**
 * The agent SDK as the rest of the server is allowed to see it.
 *
 * Which package drives the live session, and what its default system prompt is
 * called, are facts about one CLI — so they are stated here once, and a feature
 * that wants to add a paragraph or watch a tool call imports this instead of
 * naming the CLI itself.
 */
import { query, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { claudeCliPath } from "./claudeExecutable"

/** A callback the CLI runs before or after an event, e.g. a tool call. */
export type { HookCallback } from "@anthropic-ai/claude-agent-sdk"

/** Open a query only to issue control requests, and close it afterwards. */
export async function withControlQuery<T>(
  options: Pick<Options, "cwd" | "resume" | "maxTurns" | "enableFileCheckpointing">,
  use: (q: Query) => Promise<T>,
): Promise<T> {
  const abort = new AbortController()
  const q = query({
    // eslint-disable-next-line require-yield
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> { await new Promise(() => {}) })(),
    options: { ...options, abortController: abort, pathToClaudeCodeExecutable: claudeCliPath() },
  })
  try {
    return await use(q)
  } finally {
    abort.abort()
    q.close()
  }
}

/**
 * The CLI's default system prompt with `text` after it. An append already set
 * is kept and `text` follows it, so two callers can each add their own.
 */
export function appendToSystemPrompt(
  existing: Options["systemPrompt"],
  text: string,
): Options["systemPrompt"] {
  if (typeof existing === "string") return `${existing}\n\n${text}`
  if (Array.isArray(existing)) return [...existing, text]
  if (existing?.type === "custom") {
    return {
      ...existing,
      prompt: Array.isArray(existing.prompt) ? [...existing.prompt, text] : `${existing.prompt}\n\n${text}`,
    }
  }
  return {
    ...existing,
    type: "preset",
    preset: "claude_code",
    append: existing?.append ? `${existing.append}\n\n${text}` : text,
  }
}
