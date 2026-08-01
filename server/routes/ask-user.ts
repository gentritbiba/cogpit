import {
  sdkSessions,
  resolveUserQuestion,
  getSDKUserQuestions,
  listUserQuestionSessionIds,
  type UserQuestionAnswers,
} from "../sdk-session"
import { sendJson, type UseFn } from "../http"
import type { MissionControlQuestion } from "../../shared/contracts/missionControl"

export function registerAskUserRoutes(use: UseFn) {
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
    sendJson(res, 200, { bySession })
  })

  use("/api/ask-user-answer", (req, res, next) => {
    if (req.method !== "POST") {
      next()
      return
    }

    let body = ""
    req.on("data", (chunk: string) => { body += chunk })
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as {
          sessionId?: unknown
          toolUseId?: unknown
          answers?: unknown
        }

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

        if (!sdkSessions.has(sessionId)) {
          sendJson(res, 404, { error: "Session not found or not a live SDK session" })
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
