import {
  sdkSessions,
  resolveUserQuestion,
  getSDKUserQuestions,
  listUserQuestionSessionIds,
  type UserQuestionAnswers,
} from "../sdk-session"
import { sendJson, type UseFn, withJsonBody } from "../http"
import type { MissionControlQuestion } from "../../shared/contracts/missionControl"
import {
  copilotRuntime,
  type CopilotPendingUserInput,
  type CopilotRuntime,
} from "../copilot-runtime"

export type CopilotQuestionClient = Pick<
  CopilotRuntime,
  "answerUserInput" | "getPendingUserInputs" | "isSessionActive"
>

export function normalizeCopilotQuestion(
  pending: CopilotPendingUserInput,
): MissionControlQuestion {
  return {
    sessionId: pending.sessionId,
    toolUseId: pending.requestId,
    askedAt: pending.askedAt,
    questions: [{
      question: pending.question,
      multiSelect: false,
      options: (pending.choices ?? []).map((label) => ({
        label,
        hasPreview: false,
      })),
    }],
  }
}

function copilotAnswer(
  pending: CopilotPendingUserInput,
  answers: UserQuestionAnswers,
): string | undefined {
  if (typeof answers === "string") return answers
  if (Array.isArray(answers)) {
    return answers.find((answer): answer is string => typeof answer === "string")
  }
  const exact = answers[pending.question]
  if (typeof exact === "string") return exact
  return Object.values(answers).find((answer): answer is string => typeof answer === "string")
}

function matchingCopilotInput(
  pending: CopilotPendingUserInput[],
  toolUseId: string,
  answers: UserQuestionAnswers,
): CopilotPendingUserInput | undefined {
  const exact = pending.find((input) => input.requestId === toolUseId)
  if (exact) return exact
  if (typeof answers === "object" && !Array.isArray(answers)) {
    const byQuestion = pending.find((input) => Object.hasOwn(answers, input.question))
    if (byQuestion) return byQuestion
  }
  return pending.length === 1 ? pending[0] : undefined
}

export function registerAskUserRoutes(
  use: UseFn,
  copilot: CopilotQuestionClient = copilotRuntime,
) {
  /**
   * GET /api/user-questions — every AskUserQuestion call currently blocking a
   * session, grouped by session.
   *
   * Read from the live resolver map rather than from transcripts on purpose: a
   * session whose server restarted still has the tool call in its JSONL forever,
   * so a transcript-derived list would claim abandoned sessions are waiting on
   * the user. Being listed here means the question can actually be answered.
   */
  use("/api/user-questions", (req, res, next) => {
    if (req.method !== "GET") {
      next()
      return
    }
    const bySession: Record<string, MissionControlQuestion[]> = {}
    for (const sessionId of listUserQuestionSessionIds()) {
      const questions = getSDKUserQuestions(sessionId)
      if (questions.length > 0) bySession[sessionId] = questions
    }
    for (const pending of copilot.getPendingUserInputs()) {
      const questions = bySession[pending.sessionId] ?? []
      questions.push(normalizeCopilotQuestion(pending))
      bySession[pending.sessionId] = questions
    }
    sendJson(res, 200, { bySession })
  })

  use("/api/ask-user-answer", (req, res, next) => {
    if (req.method !== "POST") {
      next()
      return
    }

    withJsonBody<{
      sessionId?: unknown
      toolUseId?: unknown
      answers?: unknown
    }>(req, res, (parsed) => {
      try {
        const { sessionId, toolUseId, answers } = parsed

        if (!sessionId || typeof sessionId !== "string") {
          sendJson(res, 400, { error: "sessionId is required" })
          return
        }
        if (!toolUseId || typeof toolUseId !== "string") {
          sendJson(res, 400, { error: "toolUseId is required" })
          return
        }
        if (answers === undefined || answers === null) {
          sendJson(res, 400, { error: "answers is required" })
          return
        }

        if (
          typeof answers !== "string" &&
          !Array.isArray(answers) &&
          (typeof answers !== "object" || answers === null)
        ) {
          sendJson(res, 400, { error: "answers must be an array or object" })
          return
        }

        if (!sdkSessions.has(sessionId)) {
          const pending = matchingCopilotInput(
            copilot.getPendingUserInputs(sessionId),
            toolUseId,
            answers as UserQuestionAnswers,
          )
          if (!pending) {
            sendJson(res, 404, {
              error: copilot.isSessionActive(sessionId)
                ? "Question not found or already answered"
                : "Session not found or not a live interactive session",
            })
            return
          }
          const answer = copilotAnswer(pending, answers as UserQuestionAnswers)
          if (answer === undefined) {
            sendJson(res, 400, { error: "answers must contain an answer to the pending question" })
            return
          }
          if (
            pending.allowFreeform === false
            && pending.choices
            && !pending.choices.includes(answer)
          ) {
            sendJson(res, 400, { error: "answer must be one of the available choices" })
            return
          }
          try {
            copilot.answerUserInput(sessionId, pending.requestId, {
              answer,
              wasFreeform: !(pending.choices?.includes(answer) ?? false),
            })
          } catch (error) {
            sendJson(res, 502, {
              error: error instanceof Error ? error.message : "Failed to answer Copilot question",
              code: "COPILOT_USER_INPUT_FAILED",
            })
            return
          }
          sendJson(res, 200, { ok: true })
          return
        }

        const result = resolveUserQuestion(sessionId, toolUseId, answers as UserQuestionAnswers)
        if (!result.found) {
          sendJson(res, 404, { error: "Question not found or already answered" })
          return
        }

        sendJson(res, 200, { ok: true })
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" })
      }
    })
  })
}
