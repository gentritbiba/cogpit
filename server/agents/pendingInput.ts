import { getToolSummary } from "../../shared/session/toolSummary"
import { copilotRuntime } from "./copilotTransport"
import { allRuntimes, resolveSessionAgent } from "./runtimes"
import type { PendingInput, PendingInputResponse } from "../../shared/contracts/pendingInput"
import { AgentRuntimeError } from "./runtimeTypes"

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
      })
    }
    for (const question of runtime.listPendingQuestions(sessionId)) {
      pending.push({
        kind: "question",
        requestId: question.toolUseId,
        questions: question.questions.map((item) => ({
          question: item.question,
          multiSelect: item.multiSelect,
          options: item.options.map((option) => option.label),
        })),
      })
    }
  }
  for (const plan of copilotRuntime.getPendingExitPlans(sessionId)) {
    pending.push({
      kind: "plan",
      requestId: plan.requestId,
      summary: plan.summary,
      actions: plan.actions,
      recommendedAction: plan.recommendedAction,
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
): Promise<PendingInput> {
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
          // A message may start a turn, so the agent gets it as a send.
          const { filePath } = await resolveSessionAgent(sessionId)
          const outcome = await runtime.send(sessionId, { ...accepted.message, filePath })
          if (outcome.delivery === "busy") {
            throw new AgentRuntimeError(409, "CONFLICT", "Session is busy; the question is still waiting for an answer")
          }
        }
        answered = accepted !== null
        break
      }
      break
    }
    case "plan": {
      if (!("approved" in response)) throw mismatch(request.kind, "approved")
      copilotRuntime.answerExitPlan(sessionId, requestId, {
        approved: response.approved,
        ...(response.action ? { selectedAction: response.action } : {}),
        ...(response.feedback ? { feedback: response.feedback } : {}),
      })
      answered = true
      break
    }
  }
  if (!answered) {
    throw new AgentRuntimeError(409, "NOT_ANSWERED", "The agent did not accept that answer")
  }
  return request
}
