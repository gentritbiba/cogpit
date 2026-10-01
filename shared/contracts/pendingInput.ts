/**
 * What a session is blocked on until someone answers, in one shape across
 * agents: served by `/api/session-status` and `/api/session-requests`, and
 * answered through `/api/session-respond`.
 */

export type ApprovalDecision = "allow" | "allow_always" | "deny"

/** One answer per question, in order, or keyed by the question text. */
export type UserQuestionAnswers = Record<string, string> | string[] | string

export type PendingInput =
  | {
      kind: "permission"
      requestId: string
      toolName: string
      summary: string
      title?: string
      availableDecisions: ApprovalDecision[]
    }
  | {
      kind: "question"
      requestId: string
      questions: Array<{ question: string; multiSelect: boolean; options: string[] }>
    }
  | {
      kind: "plan"
      requestId: string
      summary: string
      actions: string[]
      recommendedAction: string
    }

export type PendingInputResponse =
  | { decision: ApprovalDecision }
  | { answers: UserQuestionAnswers }
  | { approved: boolean; action?: string; feedback?: string }
