import { isRecord } from "../../shared/objects"
import type { MissionControlQuestionItem } from "../../shared/contracts/missionControl"
import type { CodexNotification } from "./codexAppServerProtocol"
import { orchestrationStore } from "../orchestration/storage"
import type { OrchestrationStore } from "../orchestration/store"

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
  /** The native turn that asked, retained even after later turns. */
  turnId: string
  askedAt: number
  questions: MissionControlQuestionItem[]
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === "string" && field ? field : undefined
}

/** Codex sends bare option labels; Mission Control renders labelled options. */
function readQuestions(raw: unknown): MissionControlQuestionItem[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return []
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
  constructor(private readonly storage?: () => OrchestrationStore, private readonly instanceId = "default") {}

  /**
   * Async input is independent of turn/process lifetime. Only an explicit
   * answer or session deletion resolves it.
   */
  observe(notification: CodexNotification): void {
    if (!isRecord(notification.params)) return
    const params = notification.params
    const threadId = stringField(params, "threadId")
    if (!threadId) return

    if (notification.method !== "item/completed") return
    const item = params.item
    if (!isRecord(item) || item.type !== "agentMessage" || item.delivery !== "async") return

    const itemId = stringField(item, "id")
    const questions = readQuestions(item.questions)
    if (!itemId || questions.length === 0) return

    const thread = this.byThread.get(threadId) ?? new Map<string, CodexAsyncQuestion>()
    const question: CodexAsyncQuestion = {
      threadId,
      itemId,
      turnId: stringField(params, "turnId") ?? "",
      askedAt: typeof params.completedAtMs === "number" ? params.completedAtMs : Date.now(),
      questions,
    }
    if (this.storage) this.storage().putQuestion({ instanceId: this.instanceId, sessionId: threadId, requestId: itemId, data: question })
    else if (!thread.has(itemId)) thread.set(itemId, question)
    this.byThread.set(threadId, thread)
  }

  list(threadId?: string): CodexAsyncQuestion[] {
    if (this.storage) return this.storage().questions(this.instanceId, threadId).map((q) => q.data as CodexAsyncQuestion)
    const threads = threadId === undefined ? [...this.byThread.keys()] : [threadId]
    return threads.flatMap((id) => [...(this.byThread.get(id)?.values() ?? [])])
  }

  /** Drop a thread's questions — the reader has replied to it. */
  clear(threadId: string): void {
    this.byThread.delete(threadId)
    this.storage?.().deleteQuestions(this.instanceId, threadId)
  }
  resolve(threadId: string, itemId: string, commandId: string): void {
    this.byThread.get(threadId)?.delete(itemId)
    this.storage?.().resolveQuestion(this.instanceId, threadId, itemId, commandId)
  }
}

export const codexQuestions = new CodexQuestionRegistry(orchestrationStore, process.env.COGPIT_AGENT_INSTANCE_ID ?? "default")
