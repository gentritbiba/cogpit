import type { MissionControlQuestionItem } from "../../shared/contracts/missionControl"
import type { CodexNotification } from "./codexAppServerProtocol"

/**
 * Async questions Codex has asked and nobody has answered yet.
 *
 * Codex has no request/response channel for these. `request_user_input_async`
 * posts the question as an `agentMessage` item carrying `delivery: "async"`,
 * returns `{"accepted":true}` to the model at once, and lets the turn run on —
 * so nothing on the protocol is blocked and nothing is waiting for a reply.
 * The answer is an ordinary message on the thread.
 *
 * That is why this registry exists: without it a question is invisible to
 * anything outside the transcript, and Mission Control's contract is that a
 * listed question is one the reader can still answer.
 */

export interface CodexAsyncQuestion {
  threadId: string
  /** The item id, which is also the transcript's tool call id. */
  itemId: string
  /** The turn that asked; a later turn means the thread has moved on. */
  turnId: string
  askedAt: number
  questions: MissionControlQuestionItem[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === "string" && field ? field : undefined
}

/** Codex sends bare option labels; Mission Control renders labelled options. */
function readQuestions(raw: unknown): MissionControlQuestionItem[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (!isObject(entry)) return []
    const title = stringField(entry, "title") ?? stringField(entry, "question")
    if (!title) return []
    const options = Array.isArray(entry.options) ? entry.options : []
    return [{
      question: title,
      multiSelect: false,
      options: options.flatMap((option) =>
        typeof option === "string" && option
          ? [{ label: option, hasPreview: false }]
          : [],
      ),
    }]
  })
}

export class CodexQuestionRegistry {
  private readonly byThread = new Map<string, Map<string, CodexAsyncQuestion>>()

  /**
   * Record an async question, or drop a thread's questions once it starts a
   * later turn. Any answer — from Cogpit, the CLI, or another device — either
   * steers the asking turn or starts a new one, and a new turn is the only one
   * of those this connection can see.
   */
  observe(notification: CodexNotification): void {
    if (!isObject(notification.params)) return
    const params = notification.params
    const threadId = stringField(params, "threadId")
    if (!threadId) return

    if (notification.method === "turn/started") {
      const turn = isObject(params.turn) ? stringField(params.turn, "id") : undefined
      if (turn) this.clearOtherTurns(threadId, turn)
      return
    }

    if (notification.method === "thread/closed") {
      this.byThread.delete(threadId)
      return
    }

    if (notification.method !== "item/completed") return
    const item = params.item
    if (!isObject(item) || item.type !== "agentMessage" || item.delivery !== "async") return

    const itemId = stringField(item, "id")
    const questions = readQuestions(item.questions)
    if (!itemId || questions.length === 0) return

    const thread = this.byThread.get(threadId) ?? new Map<string, CodexAsyncQuestion>()
    thread.set(itemId, {
      threadId,
      itemId,
      turnId: stringField(params, "turnId") ?? "",
      askedAt: typeof params.completedAtMs === "number" ? params.completedAtMs : Date.now(),
      questions,
    })
    this.byThread.set(threadId, thread)
  }

  list(threadId?: string): CodexAsyncQuestion[] {
    const threads = threadId === undefined ? [...this.byThread.keys()] : [threadId]
    return threads.flatMap((id) => [...(this.byThread.get(id)?.values() ?? [])])
  }

  /** Drop a thread's questions — the reader has replied to it. */
  clear(threadId: string): void {
    this.byThread.delete(threadId)
  }

  private clearOtherTurns(threadId: string, turnId: string): void {
    const thread = this.byThread.get(threadId)
    if (!thread) return
    for (const [itemId, question] of thread) {
      if (question.turnId !== turnId) thread.delete(itemId)
    }
    if (thread.size === 0) this.byThread.delete(threadId)
  }
}

export const codexQuestions = new CodexQuestionRegistry()
