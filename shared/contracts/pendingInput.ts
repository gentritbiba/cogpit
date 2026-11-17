/**
 * What a session is blocked on until someone answers, in one shape across
 * agents: served by `/api/session-status` and `/api/session-requests`, and
 * answered through `/api/session-respond`.
 */

export type ApprovalDecision = "allow" | "allow_always" | "deny"

/** One answer per question, in order, or keyed by the question text. */
export type UserQuestionAnswers = Record<string, string> | string[] | string

/**
 * How a question was left unanswered: skipped, or set aside by a chat message,
 * which `answers` then carries. Only an agent whose descriptor sets
 * `capabilities.skipQuestions` takes it.
 */
export type QuestionUnanswered = "skipped" | "replied_in_chat"

export interface PendingPlan {
  sessionId: string
  requestId: string
  summary: string
  planContent?: string
  actions: string[]
  recommendedAction: string
  askedAt: number
}

export interface PlanResponse {
  approved: boolean
  selectedAction?: string
  feedback?: string
}

export type PendingInput =
  | {
      kind: "permission"
      requestId: string
      toolName: string
      summary: string
      title?: string
      availableDecisions: ApprovalDecision[]
      askedAt?: number
    }
  | {
      kind: "question"
      requestId: string
      questions: Array<{ question: string; multiSelect: boolean; options: string[] }>
      askedAt?: number
      /** The agent takes a skip for it. */
      skippable?: boolean
    }
  | {
      kind: "plan"
      requestId: string
      summary: string
      actions: string[]
      recommendedAction: string
      askedAt?: number
    }

export type PendingInputResponse =
  | { decision: ApprovalDecision }
  | { answers: UserQuestionAnswers; unanswered?: QuestionUnanswered }
  | { approved: boolean; action?: string; feedback?: string }
