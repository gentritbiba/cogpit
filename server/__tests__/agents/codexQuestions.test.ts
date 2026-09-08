// @vitest-environment node
import { describe, expect, it } from "vitest"
import { CodexQuestionRegistry } from "../../agents/codexQuestions"

/**
 * The wire shapes here are the ones `codex app-server` 0.153.4 actually sends
 * for `request_user_input_async`, captured against the real binary: the
 * question is an `agentMessage` item tagged `delivery: "async"`, whose id is
 * also the transcript's tool call id.
 */
function questionAsked(overrides: Record<string, unknown> = {}) {
  return {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1700,
      item: {
        type: "agentMessage",
        id: "call-q",
        text: "What is your budget?",
        phase: "final_answer",
        delivery: "async",
        questions: [{ title: "What is your budget?", options: ["Under 1000", "Over 1000"] }],
      },
      ...overrides,
    },
  }
}

describe("CodexQuestionRegistry", () => {
  it("records an async question with its options", () => {
    const registry = new CodexQuestionRegistry()
    registry.observe(questionAsked())

    expect(registry.list("thread-1")).toEqual([{
      threadId: "thread-1",
      itemId: "call-q",
      turnId: "turn-1",
      askedAt: 1700,
      questions: [{
        question: "What is your budget?",
        multiSelect: false,
        options: [
          { label: "Under 1000", hasPreview: false },
          { label: "Over 1000", hasPreview: false },
        ],
      }],
    }])
  })

  it("ignores ordinary agent messages, which carry no questions", () => {
    const registry = new CodexQuestionRegistry()
    registry.observe({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", id: "msg-1", text: "Done", delivery: null, questions: null },
      },
    })

    expect(registry.list()).toEqual([])
  })

  it("lists questions across every thread when asked for all of them", () => {
    const registry = new CodexQuestionRegistry()
    registry.observe(questionAsked())
    registry.observe(questionAsked({ threadId: "thread-2" }))

    expect(registry.list().map((question) => question.threadId))
      .toEqual(["thread-1", "thread-2"])
  })

  it("drops a question once the thread starts a later turn", () => {
    // Any answer — from Cogpit, the CLI, or another device — either steers the
    // asking turn or opens a new one, and a new turn is the visible case.
    const registry = new CodexQuestionRegistry()
    registry.observe(questionAsked())
    registry.observe({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-2" } },
    })

    expect(registry.list("thread-1")).toEqual([])
  })

  it("keeps a question while its own turn is still running", () => {
    const registry = new CodexQuestionRegistry()
    registry.observe(questionAsked())
    registry.observe({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    })

    expect(registry.list("thread-1")).toHaveLength(1)
  })

  it("forgets a closed thread", () => {
    const registry = new CodexQuestionRegistry()
    registry.observe(questionAsked())
    registry.observe({ method: "thread/closed", params: { threadId: "thread-1" } })

    expect(registry.list("thread-1")).toEqual([])
  })

  it("clears on request, which is what answering does", () => {
    const registry = new CodexQuestionRegistry()
    registry.observe(questionAsked())
    registry.clear("thread-1")

    expect(registry.list("thread-1")).toEqual([])
  })

  it("survives notifications with no thread or malformed items", () => {
    const registry = new CodexQuestionRegistry()
    registry.observe({ method: "item/completed", params: null })
    registry.observe({ method: "item/completed", params: { item: {} } })
    registry.observe(questionAsked({ item: { type: "agentMessage", delivery: "async" } }))

    expect(registry.list()).toEqual([])
  })
})
