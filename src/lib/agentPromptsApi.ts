/**
 * Answering the two out-of-band prompts a live session can park on: an MCP
 * elicitation and a CLI user dialog.
 *
 * Both are keyed by the control-request id, not by a tool-use id — they never
 * appear in the transcript, so the id from `GET /api/agent-prompts` is the only
 * thing that can answer them.
 */

import { postAnswer, type AnswerResult } from "@/lib/askUserApi"
import type {
  ElicitationAction,
  ElicitationContent,
  UserDialogChoice,
} from "../../shared/contracts/agentPrompts"

export interface ElicitationAnswer {
  action: ElicitationAction
  /** Form values, for `accept` only. */
  content?: ElicitationContent
}

export function submitElicitationAnswer(
  sessionId: string,
  requestId: string,
  answer: ElicitationAnswer,
): Promise<AnswerResult> {
  return postAnswer("/api/elicitation-answer", { sessionId, requestId, ...answer })
}

/**
 * `cancelled` is a real answer, not a no-op: it tells the CLI to apply the
 * dialog's own default instead of waiting out its park deadline.
 */
export function submitUserDialogChoice(
  sessionId: string,
  requestId: string,
  choice: UserDialogChoice,
): Promise<AnswerResult> {
  return postAnswer("/api/user-dialog-answer", { sessionId, requestId, choice })
}
