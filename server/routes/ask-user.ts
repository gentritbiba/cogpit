import {
  allRuntimes as defaultAllRuntimes,
  resolveSessionAgent as defaultResolveSessionAgent,
  runtimeFor as defaultRuntimeFor,
  type AgentRuntime,
  type ResolvedSessionAgent,
  type UserQuestionAnswers,
} from "../agents/runtimes"
import type { AgentKind } from "../../shared/session/agent-descriptors"
import { sendJson, type UseFn, withJsonBody } from "../http"
import type { MissionControlQuestion } from "../../shared/contracts/missionControl"
import { sendAgentError } from "./agentErrors"

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
   * GET /api/user-questions — every question currently blocking a session,
   * grouped by session.
   *
   * Read from the live runtimes rather than from transcripts on purpose: a
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
    for (const runtime of runtimes.allRuntimes()) {
      for (const question of runtime.listPendingQuestions()) {
        const questions = bySession[question.sessionId] ?? []
        questions.push(question)
        bySession[question.sessionId] = questions
      }
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
    }>(req, res, async ({ sessionId, toolUseId, answers }) => {
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
        typeof answers !== "string"
        && !Array.isArray(answers)
        && typeof answers !== "object"
      ) {
        sendJson(res, 400, { error: "answers must be an array or object" })
        return
      }

      // Dispatch on the session's agent. The old test for "is this Copilot?"
      // was "is it absent from the Claude session map", which sent every Codex
      // session down the Copilot path to collect a misleading error.
      const { kind } = await runtimes.resolveSessionAgent(sessionId)
      try {
        const answered = await runtimes
          .runtimeFor(kind)
          .answerQuestion(sessionId, toolUseId, answers as UserQuestionAnswers)
        if (!answered) {
          sendJson(res, 404, { error: "Question not found or already answered" })
          return
        }
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendAgentError(res, error, "Failed to answer the question")
      }
    })
  })
}
