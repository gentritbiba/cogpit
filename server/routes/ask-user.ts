import { sdkSessions, sendSDKMessage } from "../sdk-session"
import { sendJson } from "../helpers"
import type { UseFn } from "../helpers"

export function registerAskUserRoutes(use: UseFn) {
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

        // Build a text message from the answers.
        // answers can be string[], or Record<string, string>.
        let message: string
        if (Array.isArray(answers)) {
          message = answers.join("\n")
        } else if (typeof answers === "object") {
          message = Object.values(answers as Record<string, string>).join("\n")
        } else if (typeof answers === "string") {
          message = answers
        } else {
          sendJson(res, 400, { error: "answers must be an array or object" })
          return
        }

        const state = sendSDKMessage(sessionId, message)
        if (!state) {
          sendJson(res, 404, { error: "Session not found" })
          return
        }

        sendJson(res, 200, { ok: true })
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" })
      }
    })
  })
}
