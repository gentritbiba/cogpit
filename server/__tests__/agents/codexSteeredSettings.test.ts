// @vitest-environment node

/**
 * A model picked while a Codex turn is running.
 *
 * `turn/steer` takes input and nothing else, so the model, effort and speed a
 * steered send names cannot reach the turn it joins. They wait for the
 * thread's next turn instead, whoever starts it: the composer, a wakeup that
 * names no model of its own, or the answer to a question.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const { codex, execution } = vi.hoisted(() => {
  class ModelRejected extends Error {}
  return {
    codex: {
      listPendingApprovals: vi.fn(() => [] as unknown[]),
      listApprovalThreadIds: vi.fn(() => [] as string[]),
      getActiveTurnId: vi.fn(() => undefined as string | undefined),
      listActiveTurns: vi.fn(() => [] as unknown[]),
      subscribe: vi.fn(() => () => {}),
      shutdown: vi.fn(async () => {}),
    },
    execution: {
      ModelRejected,
      continueCodexExecution: vi.fn(async (_client: unknown, _threadId: string, _options: Record<string, unknown>) => ({
        action: "started" as "started" | "steered",
        threadId: "thread-1",
        turnId: "turn-2",
      })),
    },
  }
})

vi.mock("../../agents/codexAppServer", () => ({
  codexAppServer: codex,
  CODEX_CLIENT_CAPABILITIES: { experimentalApi: false },
}))
vi.mock("../../agents/codexExecution", () => ({
  codexSendError: (error: Error) => error,
  continueCodexExecution: execution.continueCodexExecution,
  startCodexExecution: vi.fn(),
  getCodexThreadIdentity: vi.fn(() => null),
  isCodexAppServerUnavailable: vi.fn(() => false),
  isCodexModelRejection: (error: unknown) => error instanceof execution.ModelRejected,
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
vi.mock("../../agents/index", () => ({
  storeFor: (kind: string) => ({ kind, sessionsRoot: () => `/tmp/${kind}` }),
  storeForPath: () => null,
}))

import { codexRuntime } from "../../agents/codexRuntime"
import { codexQuestions } from "../../agents/codexQuestions"

const steered = { action: "steered" as const, threadId: "thread-1", turnId: "turn-1" }

function sent(call = -1): Record<string, unknown> {
  return execution.continueCodexExecution.mock.calls.at(call)![2]
}

beforeEach(async () => {
  await codexRuntime.shutdown()
  vi.clearAllMocks()
})

describe("a model picked while a Codex turn is running", () => {
  it("runs the next turn, though the send that starts it names no model", async () => {
    execution.continueCodexExecution.mockResolvedValueOnce(steered)
    await codexRuntime.send("thread-1", { message: "use the other model", model: "gpt-6-astra", effort: "xhigh", fastMode: true })

    await codexRuntime.send("thread-1", { message: "A crew member finished" })

    expect(sent()).toMatchObject({ message: "A crew member finished", model: "gpt-6-astra", effort: "xhigh", fastMode: true })
  })

  it("gives way to what the starting send names itself", async () => {
    execution.continueCodexExecution.mockResolvedValueOnce(steered)
    await codexRuntime.send("thread-1", { message: "first pick", model: "gpt-6-astra", effort: "xhigh" })

    await codexRuntime.send("thread-1", { message: "second pick", model: "gpt-6.1-terra" })

    expect(sent()).toMatchObject({ model: "gpt-6.1-terra", effort: "xhigh" })
  })

  it("is spent once a turn has started with it", async () => {
    execution.continueCodexExecution.mockResolvedValueOnce(steered)
    await codexRuntime.send("thread-1", { message: "pick", model: "gpt-6-astra" })
    await codexRuntime.send("thread-1", { message: "starts the turn" })

    await codexRuntime.send("thread-1", { message: "a later turn" })

    expect(sent().model).toBeUndefined()
  })

  it("keeps the latest of several picks steered into the same turn", async () => {
    execution.continueCodexExecution.mockResolvedValueOnce(steered).mockResolvedValueOnce(steered).mockResolvedValueOnce(steered)
    await codexRuntime.send("thread-1", { message: "one", model: "gpt-6-astra", effort: "high" })
    await codexRuntime.send("thread-1", { message: "two", model: "gpt-6.1-terra" })
    await codexRuntime.send("thread-1", { message: "a notice that names nothing" })

    await codexRuntime.send("thread-1", { message: "next turn" })

    expect(sent()).toMatchObject({ model: "gpt-6.1-terra", effort: "high" })
  })

  it("stays with its own thread", async () => {
    execution.continueCodexExecution.mockResolvedValueOnce(steered)
    await codexRuntime.send("thread-1", { message: "pick", model: "gpt-6-astra" })

    await codexRuntime.send("thread-2", { message: "another thread" })

    expect(sent().model).toBeUndefined()
  })

  it("answers a question with the picked model, not the one the asking turn ran", async () => {
    await codexRuntime.send("thread-1", { message: "ask me", model: "gpt-6.1-sol", effort: "high" })
    codexQuestions.observe({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
        completedAtMs: 1700,
        item: { type: "agentMessage", id: "call-q", text: "Which?", delivery: "async", questions: [{ title: "Which?", options: null }] },
      },
    })
    execution.continueCodexExecution.mockResolvedValueOnce(steered)
    await codexRuntime.send("thread-1", { message: "switch", model: "gpt-6-astra" })

    const accepted = await codexRuntime.answerQuestion("thread-1", "call-q", "This one")
    await codexRuntime.send("thread-1", accepted!.message!)

    expect(sent()).toMatchObject({ message: "This one", model: "gpt-6-astra", effort: "high" })
  })

  it("is dropped when Codex rejects it, and the message starts its turn without it", async () => {
    execution.continueCodexExecution.mockResolvedValueOnce(steered)
    await codexRuntime.send("thread-1", { message: "pick", model: "gpt-no-such-model" })
    execution.continueCodexExecution.mockRejectedValueOnce(new execution.ModelRejected("The selected model may not exist"))

    const outcome = await codexRuntime.send("thread-1", { message: "A crew member finished" })

    expect(outcome.delivery).toBe("started")
    expect(sent(-2).model).toBe("gpt-no-such-model")
    expect(sent().model).toBeUndefined()
    await codexRuntime.send("thread-1", { message: "later" })
    expect(sent().model).toBeUndefined()
  })

  it("still reports a rejection of the model the send named itself", async () => {
    const rejection = new execution.ModelRejected("The selected model may not exist")
    execution.continueCodexExecution.mockRejectedValueOnce(rejection)

    await expect(codexRuntime.send("thread-1", { message: "hello", model: "gpt-no-such-model" })).rejects.toBe(rejection)
    expect(execution.continueCodexExecution).toHaveBeenCalledTimes(1)
  })
})
