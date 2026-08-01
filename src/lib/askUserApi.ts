/**
 * Answering a blocked AskUserQuestion call, shared by the timeline form, the
 * composer bar, and the Mission Control grid.
 *
 * Two traps in the wire format fail silently:
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

/** `AskUserAnswerForm` splits stored answers back apart on this exact separator. */
export function joinMultiSelect(labels: Iterable<string>): string {
  return [...labels].join(", ")
}

export interface AnswerResult {
  ok: boolean
  /** True when the server no longer knows about this question. */
  gone: boolean
}

/** Resolves rather than throwing so each caller can choose its own fallback. */
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
