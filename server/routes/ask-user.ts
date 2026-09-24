import {
  allRuntimes as defaultAllRuntimes,
  resolveSessionAgent as defaultResolveSessionAgent,
  runtimeFor as defaultRuntimeFor,
  type AgentRuntime,
  type ResolvedSessionAgent,
} from "../agents/runtimes"
import { isUserQuestionAnswers } from "../agents/runtimeTypes"
import type { AgentKind } from "../../shared/session/agent-descriptors"
import { sendJson, type UseFn, withJsonBody } from "../http"
import { authorizeSession, reportSessionEvent, sendTurn, type ActivitySessionRef } from "../edition"
import { ErrorCodes, RouteError, sendError } from "../lib/routeError"
import { sendAgentError } from "./agentErrors"
import { visibleBySession } from "./visibleBySession"

/** Test seam: the registry lookups this module resolves sessions through. */
export interface QuestionRuntimes {
  allRuntimes(): readonly AgentRuntime[]
  runtimeFor(kind: AgentKind): AgentRuntime
  resolveSessionAgent(sessionId: string): Promise<ResolvedSessionAgent>
}

const DEFAULT_RUNTIMES: QuestionRuntimes = {
  allRuntimes: defaultAllRuntimes,
  runtimeFor: defaultRuntimeFor,
  resolveSessionAgent: defaultResolveSessionAgent,
}

export function registerAskUserRoutes(
  use: UseFn,
  runtimes: QuestionRuntimes = DEFAULT_RUNTIMES,
) {
  /**
   * GET /api/user-questions — every question currently blocking a session the
   * caller may see, grouped by session.
   *
   * Read from the live runtimes rather than from transcripts on purpose: a
   * session whose server restarted still has the tool call in its JSONL forever,
   * so a transcript-derived list would claim abandoned sessions are waiting on
   * the user. Being listed here means the question can actually be answered.
   */
  use("/api/user-questions", async (req, res, next) => {
    if (req.method !== "GET") {
      next()
      return
    }
    const questions = runtimes.allRuntimes().flatMap((runtime) => runtime.listPendingQuestions())
    sendJson(res, 200, { bySession: await visibleBySession(req, questions) })
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
    }>(req, res, async ({ sessionId, toolUseId, answers }) => {
      const receivedAt = Date.now()
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
      if (!isUserQuestionAnswers(answers)) {
        sendJson(res, 400, { error: "answers must be a string, a list of strings or an object of strings" })
        return
      }

      const authorized = await authorizeSession(req, res, { sessionId }, "interact")
      if (authorized === null) return

      // Dispatch on the session's agent. The old test for "is this Copilot?"
      // was "is it absent from the Claude session map", which sent every Codex
      // session down the Copilot path to collect a misleading error.
      const { kind, filePath } = await runtimes.resolveSessionAgent(sessionId)
      const runtime = runtimes.runtimeFor(kind)
      const session: ActivitySessionRef = { sessionId: authorized.sessionId, agent: kind }
      try {
        const accepted = await runtime.answerQuestion(sessionId, toolUseId, answers)
        if (!accepted) {
          sendJson(res, 404, { error: "Question not found or already answered" })
          return
        }
        if (accepted.message === null) {
          reportSessionEvent(req, "session.answer", session, { toolUseId, answers })
        } else {
          // A message may start a turn, so it goes to the agent as a send: the turn is the answerer's.
          const outcome = await sendTurn(req, runtime, sessionId, { ...accepted.message, filePath }, { receivedAt, route: "answer", session, toolUseId })
          if (outcome.delivery === "busy") {
            sendError(res, new RouteError(409, ErrorCodes.CONFLICT, "Session is busy; the question is still waiting for an answer"))
            return
          }
        }
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendAgentError(res, error, "Failed to answer the question")
      }
    })
  })
}
