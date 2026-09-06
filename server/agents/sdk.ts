/**
 * The agent SDK as the rest of the server is allowed to see it.
 *
 * Which package drives the live session, and what its default system prompt is
 * called, are facts about one CLI — so they are stated here once, and a feature
 * that wants to add a paragraph or watch a tool call imports this instead of
 * naming the CLI itself.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk"

/** A callback the CLI runs before or after an event, e.g. a tool call. */
export type { HookCallback } from "@anthropic-ai/claude-agent-sdk"

/**
 * The CLI's default system prompt with `text` after it. An append already set
 * is kept and `text` follows it, so two callers can each add their own.
 */
export function appendToSystemPrompt(
  existing: Options["systemPrompt"],
  text: string,
): Options["systemPrompt"] {
  const preset = typeof existing === "object" && !Array.isArray(existing) ? existing : undefined
  return {
    ...preset,
    type: "preset",
    preset: "claude_code",
    append: preset?.append ? `${preset.append}\n\n${text}` : text,
  }
}
