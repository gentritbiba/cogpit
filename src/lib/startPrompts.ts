import type { SessionView } from "../../shared/session/sessionDigest"

/**
 * The message each session started from this window was created with. An agent
 * can fail before writing that message into its transcript (one does when it
 * is signed out), which would leave the conversation without the one thing the
 * user typed.
 */
const prompts = new Map<string, string>()

export function rememberStartPrompt(sessionId: string, prompt: string): void {
  if (prompt) prompts.set(sessionId, prompt)
}

/**
 * The session with its start message put back on the first turn, when the
 * transcript records no prompt at all. Anything with a prompt of its own is
 * returned as it is.
 */
export function withStartPrompt(session: SessionView): SessionView {
  const prompt = prompts.get(session.sessionId)
  if (!prompt || session.turns.length === 0 || session.turns.some((turn) => turn.userMessage !== null)) return session
  const [first, ...rest] = session.turns
  return { ...session, turns: [{ ...first, userMessage: prompt, isFragment: false }, ...rest] }
}

/** @internal test-only */
export function _resetStartPromptsForTests(): void {
  prompts.clear()
}
