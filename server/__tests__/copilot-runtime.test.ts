import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  ErrorCodes,
  ResponseError,
  type MessageConnection,
} from "vscode-jsonrpc/node.js"
import {
  CopilotRuntime,
  type CopilotJsonObject,
  type CopilotRuntimeProcess,
  type CopilotRuntimeSpawn,
  type CopilotUserInputAnswer,
} from "../copilot-runtime"

class FakeCopilotProcess extends EventEmitter implements CopilotRuntimeProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  killSignal: NodeJS.Signals | number | undefined
  closeStreamsOnKill = false

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.killed) return false
    this.killed = true
    this.killSignal = signal
    if (this.closeStreamsOnKill) {
      this.stdin.destroy()
      this.stdout.destroy()
      this.stderr.destroy()
    }
    this.emit("close", 0, null)
    return true
  }

  dispose(): void {
    this.stdin.destroy()
    this.stdout.destroy()
    this.stderr.destroy()
  }
}

interface RpcCall {
  method: string
  params: unknown
}

type RpcHandler = (params: unknown) => unknown | Promise<unknown>

interface Harness {
  runtime: CopilotRuntime
  process: FakeCopilotProcess
  server: MessageConnection
  spawn: CopilotRuntimeSpawn
  calls: RpcCall[]
  handle(method: string, handler: RpcHandler): void
}

const harnesses: Harness[] = []

function objectParams(params: unknown): CopilotJsonObject {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("Expected object params")
  }
  return params as CopilotJsonObject
}

function createHarness(
  protocolVersion = 3,
  requestTimeoutMs = 1_000,
  transportTimeoutMs = 1_000,
): Harness {
  const process = new FakeCopilotProcess()
  const server = createMessageConnection(
    new StreamMessageReader(process.stdin),
    new StreamMessageWriter(process.stdout),
  )
  const calls: RpcCall[] = []
  const handlers = new Map<string, RpcHandler>([
    ["connect", () => ({ ok: true, protocolVersion, version: "1.2.3" })],
    ["sessions.checkInUse", () => ({ inUse: [] })],
    ["session.destroy", () => null],
    ["runtime.shutdown", () => null],
  ])
  server.onRequest((method, params) => {
    calls.push({ method, params })
    const handler = handlers.get(method)
    if (!handler) throw new Error(`Unexpected RPC request: ${method}`)
    return handler(params)
  })
  server.listen()

  const spawn = vi.fn(() => process) as CopilotRuntimeSpawn
  const runtime = new CopilotRuntime({
    command: "copilot-test",
    cwd: "/workspace",
    env: { PATH: "/bin" },
    transportTimeoutMs,
    requestTimeoutMs,
    spawn,
  })
  const harness: Harness = {
    runtime,
    process,
    server,
    spawn,
    calls,
    handle: (method, handler) => handlers.set(method, handler),
  }
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  const current = harnesses.splice(0)
  await Promise.all(current.map(({ runtime }) => runtime.shutdown()))
  for (const { server, process } of current) {
    server.dispose()
    process.dispose()
  }
})

describe("CopilotRuntime", () => {
  it("reports a missing CLI before opening the JSON-RPC transport", async () => {
    const runtime = new CopilotRuntime({ env: { PATH: "" } })

    await expect(runtime.listModels()).rejects.toThrow(
      "Failed to start Copilot CLI: copilot was not found on PATH",
    )
    await expect(runtime.shutdown()).resolves.toEqual([])
  })

  it("starts lazily, performs one protocol handshake, and lists models", async () => {
    const harness = createHarness()
    harness.handle("models.list", () => ({
      models: [
        { id: "gpt-5", name: "GPT-5" },
        { id: "claude-sonnet-4.6" },
      ],
    }))

    expect(harness.spawn).not.toHaveBeenCalled()
    await expect(harness.runtime.listModels()).resolves.toEqual([
      { id: "gpt-5", name: "GPT-5" },
      { id: "claude-sonnet-4.6" },
    ])
    await harness.runtime.listModels()

    expect(harness.spawn).toHaveBeenCalledTimes(1)
    expect(harness.spawn).toHaveBeenCalledWith(
      "copilot-test",
      ["--headless", "--no-auto-update", "--stdio"],
      {
        cwd: "/workspace",
        env: { PATH: "/bin" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    expect(harness.calls.filter(({ method }) => method === "connect")).toHaveLength(1)
    expect(harness.calls[0]).toEqual({ method: "connect", params: {} })
  })

  it("reads only quota data and accumulated usage through safe RPCs", async () => {
    const harness = createHarness()
    harness.handle("account.getQuota", () => ({
      accessToken: "must-not-leak",
      quotaSnapshots: {
        chat: {
          entitlementRequests: 200,
          usedRequests: 11,
          remainingPercentage: 94.5,
          resetDate: "2026-10-01T00:00:00Z",
          accessToken: "must-not-leak",
        },
      },
    }))
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    harness.handle("session.usage.getMetrics", () => ({
      accessToken: "must-not-leak",
      totalNanoAiu: 3_947_460_000,
      totalPremiumRequestCost: 0.33,
      totalUserRequests: 1,
      modelMetrics: {
        "claude-haiku-4.5": {
          accessToken: "must-not-leak",
          totalNanoAiu: 3_947_460_000,
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            cacheReadTokens: 20,
            cacheWriteTokens: 10,
            reasoningTokens: 5,
            accessToken: "must-not-leak",
          },
        },
      },
    }))

    await expect(harness.runtime.getAccountQuota()).resolves.toEqual({
      quotaSnapshots: {
        chat: {
          entitlementRequests: 200,
          usedRequests: 11,
          remainingPercentage: 94.5,
          resetDate: "2026-10-01T00:00:00Z",
        },
      },
    })
    expect(harness.calls.find(({ method }) => method === "account.getQuota")?.params)
      .toEqual({})

    await harness.runtime.createSession({ sessionId: "usage-session" })
    await expect(harness.runtime.getSessionUsage("usage-session")).resolves.toEqual({
      totalNanoAiu: 3_947_460_000,
      totalPremiumRequestCost: 0.33,
      modelMetrics: {
        "claude-haiku-4.5": {
          totalNanoAiu: 3_947_460_000,
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            cacheReadTokens: 20,
            cacheWriteTokens: 10,
            reasoningTokens: 5,
          },
        },
      },
    })
    expect(
      harness.calls.find(({ method }) => method === "session.usage.getMetrics")?.params,
    ).toEqual({ sessionId: "usage-session" })
    await expect(harness.runtime.getSessionUsage("inactive-session")).rejects.toThrow(
      "Copilot session inactive-session is not active",
    )
  })

  it("rejects an incompatible protocol and terminates the CLI", async () => {
    const harness = createHarness(4)
    harness.handle("models.list", () => ({ models: [] }))

    await expect(harness.runtime.listModels()).rejects.toThrow(
      "Unsupported Copilot CLI protocol 4; expected 3",
    )
    expect(harness.process.killed).toBe(true)
  })

  it("times out an ordinary RPC when the CLI stays connected but stops responding", async () => {
    const harness = createHarness(3, 20)
    harness.handle("models.list", () => new Promise(() => {}))

    await expect(harness.runtime.listModels()).rejects.toThrow(
      "Copilot CLI models.list timed out",
    )
    expect(harness.spawn).toHaveBeenCalledTimes(1)
    expect(harness.process.killed).toBe(false)
  })

  it("tears down the transport when a mutating RPC times out", async () => {
    const harness = createHarness(3, 20)
    harness.handle("session.create", () => new Promise(() => {}))

    await expect(
      harness.runtime.createSession({ sessionId: "session-1" }),
    ).rejects.toThrow("Copilot CLI session.create timed out")
    expect(harness.process.killed).toBe(true)
    expect(harness.process.killSignal).toBe("SIGKILL")
    expect(harness.runtime.getActiveSessionIds()).toEqual([])
  })

  it("creates, resumes, sends, aborts, destroys, and deletes sessions", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => {
      const value = objectParams(params)
      return { sessionId: value.sessionId, workspacePath: "/workspace" }
    })
    harness.handle("session.resume", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    harness.handle("session.permissions.pendingRequests", () => ({ items: [] }))
    harness.handle("session.send", () => ({ messageId: "message-1" }))
    harness.handle("session.abort", () => null)
    harness.handle("session.permissions.setAllowAll", () => ({
      success: true,
      enabled: true,
      mode: "on",
    }))
    harness.handle("session.model.switchTo", () => ({
      modelId: "claude-sonnet-4.6",
      deferred: false,
    }))
    harness.handle("session.model.setReasoningEffort", (params) => ({
      reasoningEffort: objectParams(params).reasoningEffort,
    }))
    harness.handle("session.name.set", () => null)
    harness.handle("session.delete", () => ({ success: true }))

    await harness.runtime.createSession({
      sessionId: "created",
      workingDirectory: "/workspace",
      model: "gpt-5",
    })
    await harness.runtime.resumeSession("resumed", { continuePendingWork: true })
    await expect(harness.runtime.send("resumed", "hello")).resolves.toBe("message-1")
    await harness.runtime.abort("resumed")

    await expect(harness.runtime.setPermissionMode("resumed", true)).resolves.toBeUndefined()
    const allowAllCall = harness.calls.find(
      ({ method }) => method === "session.permissions.setAllowAll",
    )
    expect(allowAllCall?.params).toEqual({
      sessionId: "resumed",
      mode: "on",
      source: "rpc",
    })
    await expect(
      harness.runtime.setModel("resumed", "claude-sonnet-4.6", "high"),
    ).resolves.toEqual({ modelId: "claude-sonnet-4.6", deferred: false })
    expect(
      harness.calls.find(({ method }) => method === "session.model.switchTo")?.params,
    ).toEqual({
      sessionId: "resumed",
      modelId: "claude-sonnet-4.6",
      reasoningEffort: "high",
    })
    await expect(
      harness.runtime.setReasoningEffort("resumed", "medium"),
    ).resolves.toEqual({ reasoningEffort: "medium" })
    expect(
      harness.calls.find(
        ({ method }) => method === "session.model.setReasoningEffort",
      )?.params,
    ).toEqual({ sessionId: "resumed", reasoningEffort: "medium" })
    await expect(
      harness.runtime.setSessionName("resumed", "Ship Copilot support"),
    ).resolves.toBeUndefined()
    expect(harness.calls.find(({ method }) => method === "session.name.set")?.params).toEqual({
      sessionId: "resumed",
      name: "Ship Copilot support",
    })

    await harness.runtime.destroySession("created")
    await expect(harness.runtime.deleteSession("resumed")).resolves.toEqual({ success: true })
    expect(harness.runtime.getActiveSessionIds()).toEqual([])

    const create = harness.calls.find(({ method }) => method === "session.create")
    expect(create?.params).toMatchObject({
      sessionId: "created",
      workingDirectory: "/workspace",
      model: "gpt-5",
      streaming: false,
      requestPermission: true,
      requestUserInput: true,
      requestElicitation: false,
      requestExitPlanMode: true,
      requestAutoModeSwitch: false,
      hooks: false,
      includeSubAgentStreamingEvents: false,
      enableFileChangeTracking: true,
      enableConfigDiscovery: true,
      envValueMode: "direct",
    })
    expect(harness.calls.find(({ method }) => method === "session.send")?.params).toEqual({
      sessionId: "resumed",
      prompt: "hello",
    })
    expect(harness.calls.find(({ method }) => method === "session.delete")?.params).toEqual({
      sessionId: "resumed",
    })
    expect(harness.calls).toContainEqual({
      method: "sessions.checkInUse",
      params: { sessionIds: ["resumed"] },
    })
    expect(harness.calls).toContainEqual({
      method: "session.permissions.pendingRequests",
      params: { sessionId: "resumed" },
    })
  })

  it("refuses to resume a session held by another process", async () => {
    const harness = createHarness()
    harness.handle("sessions.checkInUse", () => ({ inUse: ["session-1"] }))
    harness.handle("session.resume", () => ({ sessionId: "session-1" }))

    await expect(harness.runtime.resumeSession("session-1")).rejects.toThrow(
      "Copilot session session-1 is already in use by another process",
    )
    expect(harness.calls.some(({ method }) => method === "session.resume")).toBe(false)
    expect(harness.runtime.isSessionActive("session-1")).toBe(false)
  })

  it("destroys a resumed session when its root resume event reports a conflict", async () => {
    const harness = createHarness()
    harness.handle("session.resume", async () => {
      await harness.server.sendNotification("session.event", {
        sessionId: "session-1",
        event: {
          type: "session.resume",
          data: { alreadyInUse: true },
        },
      })
      return { sessionId: "session-1" }
    })

    await expect(harness.runtime.resumeSession("session-1")).rejects.toThrow(
      "Copilot session session-1 is already in use by another process",
    )
    expect(harness.calls).toContainEqual({
      method: "session.destroy",
      params: { sessionId: "session-1" },
    })
    expect(harness.runtime.isSessionActive("session-1")).toBe(false)
  })

  it("uses the current permission-mode RPC when the stable RPC is unavailable", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    harness.handle("session.permissions.setAllowAll", () => {
      throw new ResponseError(ErrorCodes.MethodNotFound, "Unavailable")
    })
    harness.handle("session.permissions.setMode", () => ({
      success: true,
      mode: "manual",
    }))
    await harness.runtime.createSession({ sessionId: "session-1" })

    await expect(harness.runtime.setPermissionMode("session-1", false)).resolves.toBeUndefined()
    expect(harness.calls.at(-1)).toEqual({
      method: "session.permissions.setMode",
      params: { sessionId: "session-1", mode: "manual", source: "rpc" },
    })
  })

  it("forks sessions and delegates rewind operations to the native history API", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    harness.handle("sessions.fork", () => ({
      sessionId: "forked-session",
      name: "Forked work",
    }))
    harness.handle("session.history.listRewindPoints", () => ({
      fileChangeTrackingEnabled: true,
      points: [{
        eventId: "user-event-1",
        userMessage: "Make the change",
        timestamp: "2026-09-01T10:00:00.000Z",
        canRestoreFiles: true,
        fileCount: 1,
        turnChangedFiles: true,
        linesAdded: 3,
        linesRemoved: 1,
        isAutopilotContinuation: false,
      }],
    }))
    harness.handle("session.history.previewRewind", () => ({
      available: true,
      fileCount: 1,
      files: [{
        path: "/workspace/src/app.ts",
        changeType: "modified",
        linesAdded: 3,
        linesRemoved: 1,
      }],
    }))
    harness.handle("session.history.rewind", () => ({
      outcome: "success",
      eventsRemoved: 7,
      restoredFiles: ["/workspace/src/app.ts"],
      skippedFiles: [],
    }))

    await harness.runtime.createSession({ sessionId: "session-1" })
    await expect(
      harness.runtime.forkSession("session-1", {
        toEventId: "user-event-2",
        name: "Forked work",
      }),
    ).resolves.toEqual({ sessionId: "forked-session", name: "Forked work" })
    await expect(harness.runtime.listRewindPoints("session-1")).resolves.toMatchObject({
      fileChangeTrackingEnabled: true,
      points: [{ eventId: "user-event-1", fileCount: 1 }],
    })
    await expect(
      harness.runtime.previewRewind("session-1", "user-event-1"),
    ).resolves.toMatchObject({ available: true, fileCount: 1 })
    await expect(
      harness.runtime.rewind("session-1", "user-event-1", "conversation-and-files"),
    ).resolves.toMatchObject({ outcome: "success", eventsRemoved: 7 })

    expect(harness.calls).toContainEqual({
      method: "sessions.fork",
      params: {
        sessionId: "session-1",
        toEventId: "user-event-2",
        name: "Forked work",
      },
    })
    expect(harness.calls).toContainEqual({
      method: "session.history.rewind",
      params: {
        sessionId: "session-1",
        eventId: "user-event-1",
        mode: "conversation-and-files",
      },
    })
  })

  it("tracks permission events, hydrates pending requests, and sends decisions", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    harness.handle("session.permissions.pendingRequests", () => ({
      items: [{ requestId: "old-request", request: { kind: "read", path: "/tmp/a" } }],
    }))
    harness.handle("session.permissions.handlePendingPermissionRequest", () => ({
      success: true,
    }))
    await harness.runtime.createSession({ sessionId: "session-1" })

    await harness.server.sendNotification("session.event", {
      sessionId: "session-1",
      event: {
        type: "permission.requested",
        id: "event-1",
        data: {
          requestId: "request-1",
          permissionRequest: { kind: "shell", fullCommandText: "git status" },
          promptRequest: { kind: "commands", commands: ["git status"] },
        },
      },
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingPermissions("session-1")).toEqual([
        {
          sessionId: "session-1",
          requestId: "request-1",
          request: { kind: "commands", commands: ["git status"] },
          rawRequest: { kind: "shell", fullCommandText: "git status" },
          requestedAt: expect.any(Number),
        },
      ])
    })
    await expect(
      harness.runtime.respondToPermission("session-1", "request-1", {
        kind: "approve-once",
        approvedInteractively: true,
      }),
    ).resolves.toBe(true)
    expect(
      harness.calls.find(
        ({ method }) => method === "session.permissions.handlePendingPermissionRequest",
      )?.params,
    ).toEqual({
      sessionId: "session-1",
      requestId: "request-1",
      result: { kind: "approve-once", approvedInteractively: true },
    })
    expect(harness.runtime.getPendingPermissions()).toEqual([])

    await expect(harness.runtime.refreshPendingPermissions("session-1")).resolves.toEqual([
      {
        sessionId: "session-1",
        requestId: "old-request",
        request: { kind: "read", path: "/tmp/a" },
        requestedAt: expect.any(Number),
      },
    ])
  })

  it("holds user input requests until the matching answer arrives", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    await harness.runtime.createSession({ sessionId: "session-1" })
    const response = harness.server.sendRequest<CopilotUserInputAnswer>("userInput.request", {
      sessionId: "session-1",
      question: "Which environment?",
      choices: ["staging", "production"],
      allowFreeform: true,
      askedAt: expect.any(Number),
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingUserInputs("session-1")).toHaveLength(1)
    })
    const [pending] = harness.runtime.getPendingUserInputs("session-1")
    expect(pending).toMatchObject({
      sessionId: "session-1",
      question: "Which environment?",
      choices: ["staging", "production"],
      allowFreeform: true,
    })

    harness.runtime.answerUserInput("session-1", pending.requestId, {
      answer: "staging",
      wasFreeform: false,
    })
    await expect(response).resolves.toEqual({ answer: "staging", wasFreeform: false })
    expect(harness.runtime.getPendingUserInputs()).toEqual([])
  })

  it("suppresses response write failures while shutting down with pending user input", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    await harness.runtime.createSession({ sessionId: "session-1" })

    const response = harness.server.sendRequest("userInput.request", {
      sessionId: "session-1",
      question: "Which environment?",
    })
    void response.catch(() => {})
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingUserInputs("session-1")).toHaveLength(1)
    })

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    harness.process.closeStreamsOnKill = true
    try {
      await expect(harness.runtime.shutdown()).resolves.toEqual([])
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("holds exit-plan callbacks until the matching response arrives", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    await harness.runtime.createSession({ sessionId: "session-1" })

    const response = harness.server.sendRequest("exitPlanMode.request", {
      sessionId: "session-1",
      summary: "Implementation plan",
      planContent: "1. Edit the target files",
      actions: ["interactive", "autopilot"],
      recommendedAction: "interactive",
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingExitPlans("session-1")).toHaveLength(1)
    })
    const [pending] = harness.runtime.getPendingExitPlans("session-1")
    expect(pending).toMatchObject({
      sessionId: "session-1",
      summary: "Implementation plan",
      planContent: "1. Edit the target files",
      actions: ["interactive", "autopilot"],
      recommendedAction: "interactive",
    })

    harness.runtime.answerExitPlan("session-1", pending.requestId, {
      approved: true,
      selectedAction: "autopilot",
    })
    await expect(response).resolves.toEqual({
      approved: true,
      selectedAction: "autopilot",
    })
    expect(harness.runtime.getPendingExitPlans()).toEqual([])
  })

  it("keeps identical user-input request IDs isolated by session", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    await harness.runtime.createSession({ sessionId: "session-1" })
    await harness.runtime.createSession({ sessionId: "session-2" })

    const first = harness.server.sendRequest<CopilotUserInputAnswer>("userInput.request", {
      sessionId: "session-1",
      requestId: "shared-request",
      question: "First?",
    })
    const second = harness.server.sendRequest<CopilotUserInputAnswer>("userInput.request", {
      sessionId: "session-2",
      requestId: "shared-request",
      question: "Second?",
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingUserInputs()).toHaveLength(2)
    })

    harness.runtime.answerUserInput("session-1", "shared-request", {
      answer: "one",
      wasFreeform: true,
    })
    harness.runtime.answerUserInput("session-2", "shared-request", {
      answer: "two",
      wasFreeform: true,
    })
    await expect(first).resolves.toEqual({ answer: "one", wasFreeform: true })
    await expect(second).resolves.toEqual({ answer: "two", wasFreeform: true })
  })

  it("tracks live turns independently from loaded sessions", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    harness.handle("session.send", () => ({ messageId: "message-1" }))
    harness.handle("session.abort", () => null)
    await harness.runtime.createSession({ sessionId: "session-1" })

    expect(harness.runtime.isSessionActive("session-1")).toBe(true)
    expect(harness.runtime.isTurnActive("session-1")).toBe(false)
    await harness.runtime.send("session-1", "hello")
    expect(harness.runtime.isTurnActive("session-1")).toBe(true)

    await harness.server.sendNotification("session.event", {
      sessionId: "session-1",
      event: { type: "assistant.turn_end", data: {} },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.runtime.isTurnActive("session-1")).toBe(true)

    await harness.server.sendNotification("session.event", {
      sessionId: "session-1",
      event: { type: "session.idle", agentId: "subagent-1", data: {} },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.runtime.isTurnActive("session-1")).toBe(true)

    for (const type of ["abort", "session.error"]) {
      await harness.server.sendNotification("session.event", {
        sessionId: "session-1",
        event: { type: "assistant.turn_start", data: {} },
      })
      await vi.waitFor(() => expect(harness.runtime.isTurnActive("session-1")).toBe(true))
      await harness.server.sendNotification("session.event", {
        sessionId: "session-1",
        event: { type, data: {} },
      })
      await vi.waitFor(() => expect(harness.runtime.isTurnActive("session-1")).toBe(false))
    }

    await harness.server.sendNotification("session.event", {
      sessionId: "session-1",
      event: { type: "assistant.turn_start", data: {} },
    })
    await harness.server.sendNotification("session.event", {
      sessionId: "session-1",
      event: { type: "session.idle", data: {} },
    })
    await vi.waitFor(() => expect(harness.runtime.isTurnActive("session-1")).toBe(false))
    await harness.server.sendNotification("session.event", {
      sessionId: "session-1",
      event: { type: "assistant.turn_start", data: {} },
    })
    await vi.waitFor(() => expect(harness.runtime.isTurnActive("session-1")).toBe(true))
    await harness.server.sendNotification("session.event", {
      sessionId: "session-1",
      event: { type: "session.shutdown", data: {} },
    })
    await vi.waitFor(() => expect(harness.runtime.isTurnActive("session-1")).toBe(false))
    await harness.server.sendNotification("session.event", {
      sessionId: "session-1",
      event: { type: "assistant.turn_start", data: {} },
    })
    await vi.waitFor(() => expect(harness.runtime.isTurnActive("session-1")).toBe(true))
    await harness.runtime.abort("session-1")
    expect(harness.runtime.isTurnActive("session-1")).toBe(false)
  })

  it("rejects overlapping send RPCs for one session without blocking another session", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    let resolveFirst!: (value: { messageId: string }) => void
    let resolveSecond!: (value: { messageId: string }) => void
    const firstResponse = new Promise<{ messageId: string }>((resolve) => {
      resolveFirst = resolve
    })
    const secondResponse = new Promise<{ messageId: string }>((resolve) => {
      resolveSecond = resolve
    })
    harness.handle("session.send", (params) => (
      objectParams(params).sessionId === "session-1" ? firstResponse : secondResponse
    ))
    await harness.runtime.createSession({ sessionId: "session-1" })
    await harness.runtime.createSession({ sessionId: "session-2" })

    const first = harness.runtime.send("session-1", "first")
    const otherSession = harness.runtime.send("session-2", "other")
    await expect(harness.runtime.send("session-1", "overlap")).rejects.toThrow(
      "Copilot session session-1 is already accepting a message",
    )
    await vi.waitFor(() => {
      expect(harness.calls.filter(({ method }) => method === "session.send")).toHaveLength(2)
    })

    resolveFirst({ messageId: "message-1" })
    resolveSecond({ messageId: "message-2" })
    await expect(first).resolves.toBe("message-1")
    await expect(otherSession).resolves.toBe("message-2")
    expect(harness.runtime.isTurnActive("session-1")).toBe(true)
    expect(harness.runtime.isTurnActive("session-2")).toBe(true)
  })

  it("aborts a timed-out send before allowing another message", async () => {
    const harness = createHarness(3, 20)
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    let sendCount = 0
    harness.handle("session.send", () => {
      sendCount += 1
      return sendCount === 1
        ? new Promise(() => {})
        : { messageId: "message-2" }
    })
    let resolveAbort!: (value: null) => void
    harness.handle("session.abort", () => new Promise<null>((resolve) => {
      resolveAbort = resolve
    }))
    await harness.runtime.createSession({ sessionId: "session-1" })

    const sending = harness.runtime.send("session-1", "first")
    const rejected = expect(sending).rejects.toThrow("Copilot CLI session.send timed out")
    await vi.waitFor(() => {
      expect(harness.calls.some(({ method }) => method === "session.abort")).toBe(true)
    })
    await expect(harness.runtime.send("session-1", "overlap")).rejects.toThrow(
      "Copilot session session-1 is already accepting a message",
    )

    resolveAbort(null)
    await rejected
    expect(harness.process.killed).toBe(false)
    expect(harness.runtime.isSessionActive("session-1")).toBe(true)
    expect(harness.runtime.isTurnActive("session-1")).toBe(false)
    await expect(harness.runtime.send("session-1", "retry")).resolves.toBe("message-2")
  })

  it("tears down the transport when a timed-out send cannot be aborted", async () => {
    const harness = createHarness(3, 20, 20)
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    harness.handle("session.send", () => new Promise(() => {}))
    harness.handle("session.abort", () => new Promise(() => {}))
    await harness.runtime.createSession({ sessionId: "session-1" })

    await expect(harness.runtime.send("session-1", "hello")).rejects.toThrow(
      "Copilot CLI session.send timed out",
    )
    expect(harness.calls.some(({ method }) => method === "session.abort")).toBe(true)
    expect(harness.process.killed).toBe(true)
    expect(harness.process.killSignal).toBe("SIGKILL")
    expect(harness.runtime.isSessionActive("session-1")).toBe(false)
    await expect(harness.runtime.send("session-1", "retry")).rejects.toThrow(
      "Copilot session session-1 is not active",
    )
  })

  it("clears active state when the Copilot transport crashes during a send", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    harness.handle("session.send", () => new Promise(() => {}))
    await harness.runtime.createSession({ sessionId: "session-1" })

    const sending = harness.runtime.send("session-1", "hello")
    await vi.waitFor(() => {
      expect(harness.calls.some(({ method }) => method === "session.send")).toBe(true)
    })
    const rejected = expect(sending).rejects.toThrow()
    harness.process.emit("close", 9, null)

    await rejected
    expect(harness.runtime.getActiveSessionIds()).toEqual([])
    expect(harness.runtime.isTurnActive("session-1")).toBe(false)
    expect(harness.runtime.getPendingPermissions("session-1")).toEqual([])
    expect(harness.runtime.getPendingUserInputs("session-1")).toEqual([])
    expect(harness.runtime.getPendingExitPlans("session-1")).toEqual([])
  })

  it("clears turn state when session.send returns a malformed response", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    harness.handle("session.send", () => ({}))
    await harness.runtime.createSession({ sessionId: "session-1" })

    await expect(harness.runtime.send("session-1", "hello")).rejects.toThrow(
      "session.send returned no messageId",
    )
    expect(harness.runtime.isTurnActive("session-1")).toBe(false)
  })

  it("clears a pending user question when its turn is aborted", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    harness.handle("session.send", () => ({ messageId: "message-1" }))
    harness.handle("session.abort", () => null)
    await harness.runtime.createSession({ sessionId: "session-1" })
    await harness.runtime.send("session-1", "ask me")

    const response = harness.server.sendRequest("userInput.request", {
      sessionId: "session-1",
      question: "Continue?",
      choices: ["yes", "no"],
    })
    void response.catch(() => {})
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingUserInputs("session-1")).toHaveLength(1)
    })

    await harness.runtime.abort("session-1")

    expect(harness.runtime.getPendingUserInputs("session-1")).toEqual([])
    await expect(response).rejects.toThrow("Copilot turn was aborted")
  })

  it("destroys active sessions and shuts down the runtime process", async () => {
    const harness = createHarness()
    harness.handle("session.create", (params) => ({
      sessionId: objectParams(params).sessionId,
    }))
    await harness.runtime.createSession({ sessionId: "one" })
    await harness.runtime.createSession({ sessionId: "two" })

    const first = harness.runtime.shutdown()
    const second = harness.runtime.shutdown()
    expect(second).toBe(first)
    await expect(first).resolves.toEqual([])

    const destroyed = harness.calls
      .filter(({ method }) => method === "session.destroy")
      .map(({ params }) => objectParams(params).sessionId)
    expect(destroyed).toEqual(expect.arrayContaining(["one", "two"]))
    expect(harness.calls.at(-1)?.method).toBe("runtime.shutdown")
    expect(harness.process.killed).toBe(true)
    expect(harness.runtime.getActiveSessionIds()).toEqual([])
    await expect(harness.runtime.listModels()).rejects.toThrow("Copilot runtime is shut down")
  })
})
