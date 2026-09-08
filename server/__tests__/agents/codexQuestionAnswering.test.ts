// @vitest-environment node

/**
 * Answering a Codex question.
 *
 * Codex's `request_user_input_async` has no reply channel: it returns
 * `{"accepted":true}` to the model at once and the thread reads its next
 * message as the answer. So the runtime answers by sending — steering the
 * asking turn if it is still running, opening a new one if it is not — and the
 * pending question is cleared by any message, however the reader typed it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const { codex, execution } = vi.hoisted(() => ({
  codex: {
    listPendingApprovals: vi.fn(() => [] as unknown[]),
    listApprovalThreadIds: vi.fn(() => [] as string[]),
    respondApproval: vi.fn(async () => {}),
    getActiveTurnId: vi.fn(() => undefined as string | undefined),
    listActiveTurns: vi.fn(() => [] as unknown[]),
    interruptTurn: vi.fn(async () => ({})),
    subscribe: vi.fn(() => () => {}),
    shutdown: vi.fn(async () => {}),
  },
  execution: {
    continueCodexExecution: vi.fn(async () => ({
      action: "started" as const,
      threadId: "thread-1",
      turnId: "turn-2",
    })),
  },
}))

vi.mock("../../agents/codexAppServer", () => ({
  codexAppServer: codex,
  CODEX_CLIENT_CAPABILITIES: { experimentalApi: false },
}))
vi.mock("../../agents/codexExecution", () => ({
  continueCodexExecution: execution.continueCodexExecution,
  startCodexExecution: vi.fn(),
  getCodexThreadIdentity: vi.fn(() => null),
  isCodexAppServerUnavailable: vi.fn(() => false),
}))
vi.mock("../../processRegistry", () => ({
  activeProcesses: new Map(),
  persistentSessions: new Map(),
  terminateTrackedSession: vi.fn(() => false),
  killTrackedProcesses: vi.fn(() => 0),
}))
vi.mock("../../agents/sessionCwd", () => ({
  resolveSessionCwd: vi.fn(async () => "/project"),
}))
vi.mock("../../agents/spawnError", () => ({
  friendlySpawnError: vi.fn((error: Error) => error.message),
}))
vi.mock("../../agents/tempImages", () => ({
  writeTempImageFiles: vi.fn(async () => []),
  cleanupTempFiles: vi.fn(async () => {}),
}))
vi.mock("../../helpers", () => ({
  join: (...parts: string[]) => parts.join("/"),
  readFile: vi.fn(),
  spawn: vi.fn(),
  unlink: vi.fn(),
  randomUUID: vi.fn(() => "generated-uuid"),
  createInterface: vi.fn(() => ({ on: vi.fn() })),
  getSessionMeta: vi.fn(async () => null),
  homedir: () => "/Users/me",
}))
vi.mock("../../sessionPaths", () => ({
  findJsonlPath: vi.fn(async () => null),
  findNewestCodexSessionForCwd: vi.fn(async () => null),
}))
vi.mock("../../agents/index", () => ({
  storeFor: (kind: string) => ({ kind, sessionsRoot: () => `/tmp/${kind}` }),
  storeForPath: () => null,
}))

import { codexRuntime } from "../../agents/codexRuntime"
import { codexQuestions } from "../../agents/codexQuestions"
import { AgentRuntimeError } from "../../agents/runtimeTypes"

function ask(questions: Array<{ title: string; options?: string[] }>): void {
  codexQuestions.observe({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1700,
      item: {
        type: "agentMessage",
        id: "call-q",
        text: questions[0].title,
        delivery: "async",
        questions: questions.map((question) => ({
          title: question.title,
          options: question.options ?? null,
        })),
      },
    },
  })
}

function sentMessage(): string | undefined {
  const call = execution.continueCodexExecution.mock.calls.at(-1) as
    | [unknown, string, { message?: string }]
    | undefined
  return call?.[2].message
}

beforeEach(() => {
  vi.clearAllMocks()
  codexQuestions.clear("thread-1")
})

describe("codexRuntime.listPendingQuestions", () => {
  it("reports an asked question as answerable, keyed by its tool call id", () => {
    ask([{ title: "What is your budget?", options: ["Under 1000"] }])

    expect(codexRuntime.listPendingQuestions("thread-1")).toEqual([{
      sessionId: "thread-1",
      toolUseId: "call-q",
      askedAt: 1700,
      questions: [{
        question: "What is your budget?",
        multiSelect: false,
        options: [{ label: "Under 1000", hasPreview: false }],
      }],
    }])
  })

  it("reports nothing once the question is answered", async () => {
    ask([{ title: "What is your budget?" }])
    await codexRuntime.answerQuestion("thread-1", "call-q", { "What is your budget?": "900" })

    expect(codexRuntime.listPendingQuestions("thread-1")).toEqual([])
  })
})

describe("codexRuntime.answerQuestion", () => {
  it("sends a single answer as the message itself, with no echoed question", async () => {
    ask([{ title: "What is your budget?" }])

    expect(await codexRuntime.answerQuestion(
      "thread-1",
      "call-q",
      { "What is your budget?": "About 900 a month" },
    )).toBe(true)
    expect(sentMessage()).toBe("About 900 a month")
  })

  it("labels each answer when the agent asked more than one question", async () => {
    ask([{ title: "Which month?" }, { title: "Do you have a car?" }])

    await codexRuntime.answerQuestion("thread-1", "call-q", {
      "Which month?": "June",
      "Do you have a car?": "No",
    })

    expect(sentMessage()).toBe("Which month?\nJune\n\nDo you have a car?\nNo")
  })

  it("joins a multi-select answer array into one message", async () => {
    ask([{ title: "Which regions?" }])

    await codexRuntime.answerQuestion("thread-1", "call-q", ["Alps", "Jura"])

    expect(sentMessage()).toBe("Alps, Jura")
  })

  it("keeps an answer whose key does not match the question text", async () => {
    // The wire format keys answers by verbatim question text, and the server
    // does not validate them. Dropping an unmatched key would silently discard
    // the reader's typing.
    ask([{ title: "Which month?" }])

    await codexRuntime.answerQuestion("thread-1", "call-q", { "Which month": "June" })

    expect(sentMessage()).toBe("June")
  })

  it("refuses an unknown question rather than sending a stray message", async () => {
    ask([{ title: "Which month?" }])

    expect(await codexRuntime.answerQuestion("thread-1", "other-call", { a: "b" })).toBe(false)
    expect(execution.continueCodexExecution).not.toHaveBeenCalled()
  })

  it("rejects an empty answer", async () => {
    ask([{ title: "Which month?" }])

    await expect(codexRuntime.answerQuestion("thread-1", "call-q", { "Which month?": "  " }))
      .rejects.toThrow(AgentRuntimeError)
    expect(execution.continueCodexExecution).not.toHaveBeenCalled()
  })
})

describe("codexRuntime.send", () => {
  it("clears a pending question, since the message answers it", async () => {
    ask([{ title: "Which month?" }])

    await codexRuntime.send("thread-1", { message: "June, and I will have a car" })

    expect(codexRuntime.listPendingQuestions("thread-1")).toEqual([])
  })
})
