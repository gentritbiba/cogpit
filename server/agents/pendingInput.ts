import { getToolSummary } from "../../shared/session/toolSummary"
import { allRuntimes, resolveSessionAgent } from "./runtimes"
import type { PendingInput, PendingInputResponse } from "../../shared/contracts/pendingInput"
import { AgentRuntimeError } from "./runtimeTypes"
import type { IncomingMessage } from "node:http"
import { orchestrationStore } from "../orchestration/storage"
import { fingerprint } from "../orchestration/store"
import { admitSessionCommand, commandScope } from "../lib/durableSend"

/**
 * Everything a session is blocked on until someone answers: tool approvals,
 * questions, and Copilot's exit-plan prompt, in one shape an orchestrating agent
 * can read and answer without knowing which agent asked.
 *
 * Read from the live runtimes, so a listed request is one that can still be
 * answered — the same guarantee `/api/permissions` and `/api/user-questions`
 * give the UI.
 */

export type { PendingInput, PendingInputResponse } from "../../shared/contracts/pendingInput"

export function listPendingInput(sessionId: string): PendingInput[] {
  const pending: PendingInput[] = []
  for (const runtime of allRuntimes()) {
    for (const approval of runtime.listPendingApprovals(sessionId)) {
      pending.push({
        kind: "permission",
        requestId: approval.requestId,
        toolName: approval.toolName,
        summary: approval.summary ?? getToolSummary({ name: approval.toolName, input: approval.input }),
        ...(approval.title && { title: approval.title }),
        availableDecisions: approval.availableDecisions,
        ...(approval.timestamp !== undefined && { askedAt: approval.timestamp }),
      })
    }
    for (const question of runtime.listPendingQuestions(sessionId)) {
      pending.push({
        kind: "question",
        requestId: question.toolUseId,
        ...(question.askedAt !== undefined && { askedAt: question.askedAt }),
        questions: question.questions.map((item) => ({
          question: item.question,
          multiSelect: item.multiSelect,
          options: item.options.map((option) => option.label),
        })),
      })
    }
    for (const plan of runtime.listPendingPlans?.(sessionId) ?? []) pending.push({
      kind: "plan",
      requestId: plan.requestId,
      summary: plan.summary,
      actions: plan.actions,
      recommendedAction: plan.recommendedAction,
      ...(plan.askedAt !== undefined && { askedAt: plan.askedAt }),
    })
  }
  return pending
}

function mismatch(kind: PendingInput["kind"], expected: string): AgentRuntimeError {
  return new AgentRuntimeError(400, "INVALID_RESPONSE", `Request is a ${kind}; answer it with ${expected}`)
}

/** Answer one pending request, returning the request that was answered. */
export async function respondToPendingInput(
  sessionId: string,
  requestId: string,
  response: PendingInputResponse,
  options: { commandId?: string; req?: IncomingMessage } = {},
): Promise<PendingInput> {
  const old = options.commandId ? orchestrationStore().command(commandScope(options.req), options.commandId) : null
  if (old && "answers" in response) {
    if (old.receipt.sessionId !== sessionId || old.payload.questionId !== requestId || fingerprint(old.payload.answerInput) !== fingerprint(response.answers)) throw new AgentRuntimeError(409, "CONFLICT", "commandId was reused with another answer")
    return { kind: "question", requestId, questions: [] }
  }
  const request = listPendingInput(sessionId).find((pending) => pending.requestId === requestId)
  if (!request) {
    throw new AgentRuntimeError(404, "NOT_FOUND", "No pending request with that id; it may already be answered")
  }

  let answered = false
  switch (request.kind) {
    case "permission": {
      if (!("decision" in response)) throw mismatch(request.kind, "a decision")
      for (const runtime of allRuntimes()) {
        if (!runtime.listPendingApprovals(sessionId).some((a) => a.requestId === requestId)) continue
        answered = await runtime.respondToApproval(sessionId, requestId, response.decision)
        break
      }
      break
    }
    case "question": {
      if (!("answers" in response)) throw mismatch(request.kind, "answers")
      for (const runtime of allRuntimes()) {
        if (!runtime.listPendingQuestions(sessionId).some((q) => q.toolUseId === requestId)) continue
        const accepted = await runtime.answerQuestion(sessionId, requestId, response.answers)
        if (accepted?.message) {
          if (options.commandId) {
            await admitSessionCommand({ sessionId, commandId: options.commandId, request: accepted.message, req: options.req, runtime, answer: accepted, answerInput: response.answers })
            answered = true
            break
          }
          // A message may start a turn, so the agent gets it as a send.
          const { filePath } = await resolveSessionAgent(sessionId)
          const outcome = await runtime.send(sessionId, { ...accepted.message, filePath })
          if (outcome.delivery === "busy") {
            throw new AgentRuntimeError(409, "CONFLICT", "Session is busy; the question is still waiting for an answer")
          }
          accepted.onDelivered?.()
        }
        answered = accepted !== null
        break
      }
      break
    }
    case "plan": {
      if (!("approved" in response)) throw mismatch(request.kind, "approved")
      for (const runtime of allRuntimes()) {
        if (!runtime.listPendingPlans?.(sessionId).some((plan) => plan.requestId === requestId)) continue
        answered = await runtime.respondToPlan?.(sessionId, requestId, {
          approved: response.approved,
          ...(response.action ? { selectedAction: response.action } : {}),
          ...(response.feedback ? { feedback: response.feedback } : {}),
        }) ?? false
        break
      }
      break
    }
  }
  if (!answered) {
    throw new AgentRuntimeError(409, "NOT_ANSWERED", "The agent did not accept that answer")
  }
  return request
}
