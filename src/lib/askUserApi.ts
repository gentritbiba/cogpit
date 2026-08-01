/**
 * Answering a blocked AskUserQuestion call.
 *
 * Shared because three surfaces answer questions — the timeline form, the
 * composer bar, and the Mission Control grid — and the wire format has two
 * traps that fail silently:
 *
 * - Answer keys must be the verbatim question text. The server does no key
 *   validation, so a mistyped key returns 200 and hands the agent an answer map
 *   matching none of its questions.
 * - Multi-select answers are ONE comma-space-joined string, not an array. An
 *   array makes the server return 404 "already answered", which a caller would
 *   reasonably read as success and drop the user's input.
 */

import { authFetch } from "@/lib/auth"

/** Answers keyed by the exact question text the agent asked. */
export type UserQuestionAnswerMap = Record<string, string>

/**
 * Join multi-select labels the way the SDK expects.
 *
 * `AskUserAnswerForm` splits stored answers back apart on this exact separator,
 * so it has to stay ", ".
 */
export function joinMultiSelect(labels: Iterable<string>): string {
  return [...labels].join(", ")
}

export interface AnswerResult {
  ok: boolean
  /** True when the server no longer knows about this question. */
  gone: boolean
}

/**
 * Submit answers for one blocked tool call.
 *
 * Resolves rather than throwing so callers can choose their own fallback: the
 * in-session surfaces re-deliver the text as a chat message, while the grid
 * simply reports that the question moved on.
 */
export async function submitUserQuestionAnswers(
  sessionId: string,
  toolUseId: string,
  answers: UserQuestionAnswerMap,
): Promise<AnswerResult> {
  try {
    const res = await authFetch("/api/ask-user-answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, toolUseId, answers }),
    })
    return { ok: res.ok, gone: res.status === 404 }
  } catch {
    return { ok: false, gone: false }
  }
}
