// @vitest-environment node

/**
 * A model picked while a Codex turn is running.
 *
 * `turn/steer` takes input and nothing else, so the model, effort and speed a
 * steered send names cannot reach the turn it joins. They wait for the
 * thread's next turn instead, whoever starts it: the composer, a wakeup that
 * names no model of its own, or the answer to a question.
 *
 * Codex accepts any model name on `turn/start` and fails the turn a few
 * seconds later when the provider will not serve it, keeping that model for
 * the thread's later turns. Turn completions here come over the wire from a
 * real `CodexAppServer`, in the shapes Codex 0.163–0.167 send.
 */

import { EventEmitter } from "node:events"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CodexAppServer as CodexAppServerClass } from "../../agents/codexAppServer"
import type { CodexContinuationResult, CodexTurnModel } from "../../agents/codexExecution"

const { execution, models, wire } = vi.hoisted(() => ({
  execution: {
    continueCodexExecution: vi.fn(async (_client: unknown, _threadId: string, _options: Record<string, unknown>): Promise<CodexContinuationResult> => ({
      action: "started",
      threadId: "thread-1",
      turnId: "turn-2",
      turnModel: {},
    })),
  },
  models: { fetchCodexModels: vi.fn(async () => null as Array<{ value: string; resolvedModel?: string }> | null) },
  wire: { server: undefined as unknown as CodexAppServerClass, child: undefined as unknown as FakeCodex },
}))

vi.mock("../../agents/codexAppServer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/codexAppServer")>()
  const codexAppServer = new Proxy({}, {
    get: (_target, key) => {
      const value: unknown = Reflect.get(wire.server, key)
      return typeof value === "function" ? value.bind(wire.server) : value
    },
  })
  return { ...actual, codexAppServer }
})
vi.mock("../../agents/codexExecution", () => ({
  codexSendError: (error: Error) => error,
  continueCodexExecution: execution.continueCodexExecution,
  startCodexExecution: vi.fn(),
  getCodexThreadIdentity: vi.fn(() => null),
  isCodexAppServerUnavailable: vi.fn(() => false),
}))
vi.mock("../../agents/codexModels", () => models)
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

import { CodexAppServer } from "../../agents/codexAppServer"
import { codexRuntime } from "../../agents/codexRuntime"
import { codexQuestions } from "../../agents/codexQuestions"

/** The app-server end of the pipe: answers `initialize` and sends what a test tells it to. */
class FakeCodex extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false

  constructor() {
    super()
    createInterface({ input: this.stdin }).on("line", (line) => {
      const message = JSON.parse(line) as { id?: number; method?: string }
      if (message.method === "initialize") this.send({ id: message.id, result: { userAgent: "cogpit/0.167.2 (Mac OS 26.0.0; arm64)" } })
    })
  }

  send(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  kill(): boolean {
    this.killed = true
    this.emit("close", null, "SIGTERM")
    return true
  }
}

const NOT_FOUND = "The 'gpt-no-such-model' model is not supported when using Codex with a ChatGPT account."
const REFUSALS = [
  ["0.165+", { message: NOT_FOUND, codexErrorInfo: "modelNotFound", additionalDetails: null, misalignment: null }],
  ["0.164 and earlier", { message: JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: NOT_FOUND, code: "model_not_found" } }), codexErrorInfo: "other", additionalDetails: null, misalignment: null }],
] as const
const REFUSED = REFUSALS[0][1]

const steered = { action: "steered" as const, threadId: "thread-1", turnId: "turn-1" }

function started(turnId: string, turnModel: CodexTurnModel = {}) {
  return { action: "started" as const, threadId: "thread-1", turnId, turnModel }
}

function sent(call = -1): Record<string, unknown> {
  return execution.continueCodexExecution.mock.calls.at(call)![2]
}

/** `turn/completed` as Codex sends it; `error` makes it a failed turn. */
function turnCompleted(turnId: string, error?: Record<string, unknown>): void {
  wire.child.send({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: turnId, rootTurnId: turnId, items: [], itemsView: "notLoaded", status: error ? "failed" : "completed", error: error ?? null, startedAt: 1794940675, completedAt: 1794940678, durationMs: 3083 },
    },
  })
}

/** The thread's first turn ran on `model` and finished. */
async function ranOn(model: string, effort = "low"): Promise<void> {
  execution.continueCodexExecution.mockResolvedValueOnce(started("turn-1", { model, effort, fastMode: false }))
  await codexRuntime.send("thread-1", { message: "start working" })
  turnCompleted("turn-1")
  await expect(codexRuntime.waitForCompletion!("thread-1", "turn-1")).resolves.toEqual({ isError: false })
}

beforeEach(async () => {
  wire.server ??= new CodexAppServer()
  await codexRuntime.shutdown()
  vi.clearAllMocks()
  wire.server = new CodexAppServer({
    spawn: () => {
      wire.child = new FakeCodex()
      return wire.child
    },
  })
  await wire.server.start()
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
})

describe("a picked model Codex refuses", () => {
  it.each(REFUSALS)("starts the refused turn again on the model the thread ran before (Codex %s)", async (_version, refusal) => {
    await ranOn("gpt-6.1-sol")
    execution.continueCodexExecution.mockResolvedValueOnce(steered)
    await codexRuntime.send("thread-1", { message: "pick", model: "gpt-no-such-model", effort: "ultra" })
    execution.continueCodexExecution.mockResolvedValueOnce(started("turn-2", { model: "gpt-no-such-model", effort: "ultra" }))
    const outcome = await codexRuntime.send("thread-1", { message: "A crew member finished", commandId: "command-7" })
    const completion = codexRuntime.waitForCompletion!("thread-1", outcome.turnId!)
    execution.continueCodexExecution.mockResolvedValueOnce(started("turn-3", { model: "gpt-6.1-sol", effort: "low" }))

    turnCompleted("turn-2", refusal)

    await vi.waitFor(() => expect(execution.continueCodexExecution).toHaveBeenCalledTimes(4))
    expect(outcome).toEqual({ delivery: "started", turnId: "turn-2" })
    expect(sent(-2)).toMatchObject({ message: "A crew member finished", model: "gpt-no-such-model", effort: "ultra" })
    // Codex recorded the message with the refused turn; the new turn answers it.
    expect(sent()).toMatchObject({ model: "gpt-6.1-sol", effort: "low", fastMode: false, deliveryIntent: "queue" })
    expect(sent()).not.toHaveProperty("message")
    expect(sent()).not.toHaveProperty("commandId")
    turnCompleted("turn-3")
    await expect(completion).resolves.toEqual({ isError: false })
  })

  it("keeps what the starting send named itself when it starts the turn again", async () => {
    await ranOn("gpt-6.1-sol")
    execution.continueCodexExecution.mockResolvedValueOnce(steered)
    await codexRuntime.send("thread-1", { message: "pick", model: "gpt-no-such-model" })
    execution.continueCodexExecution.mockResolvedValueOnce(started("turn-2"))
    await codexRuntime.send("thread-1", { message: "go faster", fastMode: true })
    execution.continueCodexExecution.mockResolvedValueOnce(started("turn-3"))

    turnCompleted("turn-2", REFUSED)

    await vi.waitFor(() => expect(execution.continueCodexExecution).toHaveBeenCalledTimes(4))
    expect(sent()).toMatchObject({ model: "gpt-6.1-sol", effort: "low", fastMode: true })
  })

  it("lets a turn already running answer the refused one's message", async () => {
    await ranOn("gpt-6.1-sol")
    execution.continueCodexExecution.mockResolvedValueOnce(steered)
    await codexRuntime.send("thread-1", { message: "pick", model: "gpt-no-such-model" })
    execution.continueCodexExecution.mockResolvedValueOnce(started("turn-2"))
    await codexRuntime.send("thread-1", { message: "A crew member finished" })
    const completion = codexRuntime.waitForCompletion!("thread-1", "turn-2")
    execution.continueCodexExecution.mockResolvedValueOnce({ action: "busy", threadId: "thread-1", turnId: "turn-9" })

    turnCompleted("turn-2", REFUSED)
    await vi.waitFor(() => expect(execution.continueCodexExecution).toHaveBeenCalledTimes(4))
    turnCompleted("turn-9")

    await expect(completion).resolves.toEqual({ isError: false })
  })

  it("reports a model the send named itself, and the next send that names none goes back", async () => {
    await ranOn("gpt-6-astra", "high")
    execution.continueCodexExecution.mockResolvedValueOnce(started("turn-2", { model: "gpt-no-such-model" }))
    await codexRuntime.send("thread-1", { message: "hello", model: "gpt-no-such-model" })

    turnCompleted("turn-2", REFUSED)

    await expect(codexRuntime.waitForCompletion!("thread-1", "turn-2")).resolves.toEqual({
      isError: true,
      message: NOT_FOUND,
      failure: { reason: "model_unavailable", message: NOT_FOUND },
    })
    expect(execution.continueCodexExecution).toHaveBeenCalledTimes(2)
    execution.continueCodexExecution.mockResolvedValueOnce(started("turn-3"))
    await codexRuntime.send("thread-1", { message: "on Default this time" })
    expect(sent()).toMatchObject({ model: "gpt-6-astra", effort: "high" })
    execution.continueCodexExecution.mockResolvedValueOnce(started("turn-4"))
    await codexRuntime.send("thread-1", { message: "a later turn" })
    expect(sent().model).toBeUndefined()
  })

  it("goes back to Codex's recommended model when the thread ran no other", async () => {
    models.fetchCodexModels.mockResolvedValueOnce([{ value: "", resolvedModel: "gpt-6.2-sol" }, { value: "gpt-6.2-sol" }])
    execution.continueCodexExecution.mockResolvedValueOnce(started("turn-1", { model: "gpt-no-such-model" }))
    await codexRuntime.send("thread-1", { message: "hello", model: "gpt-no-such-model" })
    turnCompleted("turn-1", REFUSED)
    await codexRuntime.waitForCompletion!("thread-1", "turn-1")

    await codexRuntime.send("thread-1", { message: "on Default this time" })

    expect(sent().model).toBe("gpt-6.2-sol")
  })
})
