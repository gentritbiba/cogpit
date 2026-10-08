/**
 * Answering a blocked AskUserQuestion call, shared by the timeline form, the
 * composer bar, and the Mission Control grid.
 *
 * Answers use exact question text as keys. A multi-select answer is one
 * comma-space-joined string. Durable delivery keeps a stable receipt ID across retries.
 */

import { jsonFetch } from "@/lib/auth"
import { answerShareQuestion } from "@/lib/shareApi"
import { isSharedPath } from "@/lib/sharePath"
import { deliverCommand } from "./commandDelivery"

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
export async function postAnswer(url: string, body: unknown): Promise<AnswerResult> {
  try {
    const res = await jsonFetch(url, body)
    return { ok: res.ok, gone: res.status === 404 }
  } catch {
    return { ok: false, gone: false }
  }
}

export function submitUserQuestionAnswers(
  sessionId: string,
  toolUseId: string,
  answers: UserQuestionAnswerMap,
): Promise<AnswerResult> {
  // A share guest reaches the same handler through the token-scoped namespace,
  // where the session comes from the cookie. Routed here rather than at each
  // call site because the timeline form and the composer both import this
  // directly, and a missed one would silently 403 and swallow the answer.
  if (isSharedPath(window.location.pathname)) {
    return answerShareQuestion(toolUseId, answers)
  }
  return deliverCommand("/api/ask-user-answer", { sessionId, toolUseId, answers })
    .then((res) => ({ ok: res.ok, gone: res.status === 404 }), () => ({ ok: false, gone: false }))
}
