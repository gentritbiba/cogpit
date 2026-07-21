// @vitest-environment node
import { EventEmitter } from "node:events"
import type { SpawnOptionsWithoutStdio } from "node:child_process"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CodexAppServer,
  CodexAppServerRpcError,
  type CodexAppServerProcess,
  type CodexAppServerSpawn,
  type JsonObject,
} from "../codex-app-server"

class FakeCodexProcess
  extends EventEmitter
  implements CodexAppServerProcess
{
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: JsonObject[] = []
  killed = false
  ignoreSigterm = false
  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    this.killed = true
    const resolvedSignal = typeof signal === "string" ? signal : "SIGTERM"
    if (resolvedSignal !== "SIGTERM" || !this.ignoreSigterm) {
      this.emit("close", null, resolvedSignal)
    }
    return true
  })

  private inputBuffer = ""

  constructor() {
    super()
    this.stdin.setEncoding("utf8")
    this.stdin.on("data", (chunk: string) => {
      this.inputBuffer += chunk
      for (;;) {
        const newline = this.inputBuffer.indexOf("\n")
        if (newline < 0) break
        const line = this.inputBuffer.slice(0, newline)
        this.inputBuffer = this.inputBuffer.slice(newline + 1)
        if (line) this.messages.push(JSON.parse(line) as JsonObject)
      }
    })
  }

  send(message: JsonObject): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  close(code = 1, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal)
  }
}

interface Harness {
  server: CodexAppServer
  children: FakeCodexProcess[]
  spawn: ReturnType<typeof vi.fn<CodexAppServerSpawn>>
}

const servers: CodexAppServer[] = []

function createHarness(options: { requestTimeoutMs?: number } = {}): Harness {
  const children: FakeCodexProcess[] = []
  const spawn = vi.fn<CodexAppServerSpawn>(
    (
      _command: string,
      _args: string[],
      _spawnOptions: SpawnOptionsWithoutStdio & {
        stdio: ["pipe", "pipe", "pipe"]
      },
    ) => {
      const child = new FakeCodexProcess()
      children.push(child)
      return child
    },
  )
  const server = new CodexAppServer({
    spawn,
    requestTimeoutMs: options.requestTimeoutMs,
    clientVersion: "9.8.7",
    now: () => 123_456,
  })
  servers.push(server)
  return { server, children, spawn }
}

async function initialize(harness: Harness): Promise<FakeCodexProcess> {
  const promise = harness.server.start()
  const child = harness.children.at(-1)
  if (!child) throw new Error("Expected Codex child to be spawned")
  const request = child.messages[0]
  child.send({ id: request.id, result: { userAgent: "codex-test" } })
  await promise
  return child
}

function requestFor(child: FakeCodexProcess, method: string): JsonObject {
  const request = child.messages.find((message) => message.method === method)
  if (!request) throw new Error(`Expected ${method} request`)
  return request
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map((server) => server.shutdown()))
})

describe("CodexAppServer transport", () => {
  it("spawns one persistent stdio server and performs the documented handshake", async () => {
    const harness = createHarness()
    const firstStart = harness.server.start()
    const secondStart = harness.server.start()
    expect(harness.spawn).toHaveBeenCalledTimes(1)
    expect(harness.spawn).toHaveBeenCalledWith(
      "codex",
      ["app-server", "--stdio"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    )

    const child = harness.children[0]
    expect(child.messages).toEqual([
      {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "cogpit",
            title: "Cogpit",
            version: "9.8.7",
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
          },
        },
      },
    ])
    expect(child.messages[0]).not.toHaveProperty("jsonrpc")

    child.send({ id: 1, result: { platformFamily: "unix" } })
    await expect(firstStart).resolves.toEqual({ platformFamily: "unix" })
    await expect(secondStart).resolves.toEqual({ platformFamily: "unix" })
    expect(child.messages.at(-1)).toEqual({ method: "initialized", params: {} })

    await harness.server.start()
    expect(harness.spawn).toHaveBeenCalledTimes(1)
  })

  it("correlates concurrent responses and exposes RPC errors", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    const left = harness.server.call<{ value: string }>("test/left", { n: 1 })
    const right = harness.server.call<{ value: string }>("test/right", { n: 2 })
    const leftRequest = requestFor(child, "test/left")
    const rightRequest = requestFor(child, "test/right")

    child.send({ id: rightRequest.id, result: { value: "right" } })
    child.send({
      id: leftRequest.id,
      error: { code: -32602, message: "bad params", data: { n: 1 } },
    })

    await expect(right).resolves.toEqual({ value: "right" })
    await expect(left).rejects.toMatchObject({
      name: "CodexAppServerRpcError",
      code: -32602,
      method: "test/left",
      data: { n: 1 },
    } satisfies Partial<CodexAppServerRpcError>)
  })

  it("times out calls and ignores a response that arrives after the timeout", async () => {
    const harness = createHarness({ requestTimeoutMs: 50 })
    await initialize(harness)
    vi.useFakeTimers()

    const call = harness.server.call("test/slow", {})
    await vi.advanceTimersByTimeAsync(50)
    await expect(call).rejects.toThrow("test/slow timed out after 50ms")

    const child = harness.children[0]
    const request = requestFor(child, "test/slow")
    child.send({ id: request.id, result: { late: true } })
    await Promise.resolve()
  })

  it("rejects in-flight calls on close and reconnects on the next call", async () => {
    const harness = createHarness()
    const firstChild = await initialize(harness)
    const interrupted = harness.server.call("test/pending", {})
    firstChild.stderr.write("lost transport")
    firstChild.close(7)
    await expect(interrupted).rejects.toThrow(
      "Codex app-server exited with code 7: lost transport",
    )

    const reconnectedCall = harness.server.call<{ ok: boolean }>("test/again", {})
    expect(harness.children).toHaveLength(2)
    const secondChild = harness.children[1]
    const initializeRequest = requestFor(secondChild, "initialize")
    secondChild.send({ id: initializeRequest.id, result: {} })
    await vi.waitFor(() => {
      expect(requestFor(secondChild, "test/again")).toBeDefined()
    })
    const request = requestFor(secondChild, "test/again")
    secondChild.send({ id: request.id, result: { ok: true } })
    await expect(reconnectedCall).resolves.toEqual({ ok: true })
    expect(harness.spawn).toHaveBeenCalledTimes(2)
  })

  it("rejects pending work on restart and never keeps two children alive", async () => {
    const harness = createHarness()
    const firstChild = await initialize(harness)
    const interrupted = harness.server.call("test/pending", {})
    const restart = harness.server.restart()
    await expect(interrupted).rejects.toThrow("connection restarted")
    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM")
    expect(harness.children).toHaveLength(2)

    const secondChild = harness.children[1]
    const initializeRequest = requestFor(secondChild, "initialize")
    secondChild.send({ id: initializeRequest.id, result: {} })
    await expect(restart).resolves.toEqual({})
  })

  it("answers current-time requests and rejects unsupported server requests", async () => {
    const harness = createHarness()
    const child = await initialize(harness)

    child.send({
      id: "time-1",
      method: "currentTime/read",
      params: { threadId: "thread-1" },
    })
    await vi.waitFor(() => {
      expect(child.messages).toContainEqual({
        id: "time-1",
        result: { currentTimeAt: 123 },
      })
    })

    child.send({
      id: "unsupported-1",
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1" },
    })
    await vi.waitFor(() => {
      expect(child.messages).toContainEqual({
        id: "unsupported-1",
        error: {
          code: -32601,
          message: "Unsupported Codex server request: item/tool/requestUserInput",
        },
      })
    })
  })

  it("rejects malformed supported server requests instead of leaving them pending", async () => {
    const harness = createHarness()
    const child = await initialize(harness)

    child.send({
      id: "approval-invalid",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1" },
    })

    await vi.waitFor(() => {
      expect(child.messages).toContainEqual({
        id: "approval-invalid",
        error: {
          code: -32602,
          message:
            "Invalid params for Codex server request item/commandExecution/requestApproval",
        },
      })
    })
    expect(harness.server.listPendingApprovals("thread-1")).toEqual([])
  })
})

describe("CodexAppServer threads and goals", () => {
  it("tracks active turn ids for steering and interruption", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    const notifications = vi.fn()
    harness.server.subscribe(notifications)

    const start = harness.server.startTurn("thread-1", "Run the tests", {
      model: "gpt-5.6",
    })
    const startRequest = requestFor(child, "turn/start")
    expect(startRequest.params).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Run the tests", text_elements: [] }],
      model: "gpt-5.6",
    })
    child.send({
      id: startRequest.id,
      result: { turn: { id: "turn-1", status: "inProgress", items: [] } },
    })
    await start
    expect(harness.server.getActiveTurnId("thread-1")).toBe("turn-1")

    const steer = harness.server.steerTurn("thread-1", "Focus on unit tests")
    const steerRequest = requestFor(child, "turn/steer")
    expect(steerRequest.params).toEqual({
      threadId: "thread-1",
      input: [
        { type: "text", text: "Focus on unit tests", text_elements: [] },
      ],
      expectedTurnId: "turn-1",
    })
    child.send({ id: steerRequest.id, result: { turnId: "turn-1" } })
    await steer

    const interrupt = harness.server.interruptTurn("thread-1")
    const interruptRequest = requestFor(child, "turn/interrupt")
    expect(interruptRequest.params).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    })
    child.send({ id: interruptRequest.id, result: {} })
    await interrupt

    const completed = {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "interrupted" },
      },
    }
    child.send(completed)
    expect(harness.server.getActiveTurnId("thread-1")).toBeUndefined()
    expect(notifications).toHaveBeenCalledWith(completed)
  })

  it("lists active parent and subagent turns reported by the transport", async () => {
    const harness = createHarness()
    const child = await initialize(harness)

    child.send({
      method: "turn/started",
      params: {
        threadId: "thread-parent",
        turn: { id: "turn-parent", status: "inProgress" },
      },
    })
    child.send({
      method: "turn/started",
      params: {
        threadId: "thread-child",
        turn: { id: "turn-child", status: "inProgress" },
      },
    })

    expect(harness.server.listActiveTurns()).toEqual([
      { threadId: "thread-parent", turnId: "turn-parent" },
      { threadId: "thread-child", turnId: "turn-child" },
    ])
  })

  it("wraps thread lifecycle and persisted goal methods", async () => {
    const harness = createHarness()
    const child = await initialize(harness)

    const started = harness.server.startThread({ cwd: "/project" })
    const startRequest = requestFor(child, "thread/start")
    child.send({ id: startRequest.id, result: { thread: { id: "thread-1" } } })
    await expect(started).resolves.toEqual({ thread: { id: "thread-1" } })

    const resumed = harness.server.resumeThread("thread-1", {
      personality: "friendly",
    })
    const resumeRequest = requestFor(child, "thread/resume")
    expect(resumeRequest.params).toEqual({
      threadId: "thread-1",
      personality: "friendly",
    })
    child.send({ id: resumeRequest.id, result: { thread: { id: "thread-1" } } })
    await resumed

    const set = harness.server.setGoal("thread-1", {
      objective: "Ship it",
      tokenBudget: 40_000,
    })
    const setRequest = requestFor(child, "thread/goal/set")
    expect(setRequest.params).toEqual({
      threadId: "thread-1",
      objective: "Ship it",
      tokenBudget: 40_000,
    })
    child.send({ id: setRequest.id, result: { goal: null } })
    await set

    const get = harness.server.getGoal("thread-1")
    const getRequest = requestFor(child, "thread/goal/get")
    child.send({ id: getRequest.id, result: { goal: null } })
    await expect(get).resolves.toEqual({ goal: null })

    const clear = harness.server.clearGoal("thread-1")
    const clearRequest = requestFor(child, "thread/goal/clear")
    child.send({ id: clearRequest.id, result: { cleared: true } })
    await expect(clear).resolves.toEqual({ cleared: true })
  })
})

describe("CodexAppServer approvals", () => {
  it("normalizes command and file approvals by thread", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    const approvalChanges = vi.fn()
    harness.server.subscribeApprovals(approvalChanges)

    child.send({
      method: "item/commandExecution/requestApproval",
      id: "approval-command",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-command",
        startedAtMs: 99,
        reason: "Needs network",
        command: "npm test",
        cwd: "/project",
        networkApprovalContext: { host: "registry.npmjs.org" },
      },
    })
    child.send({
      method: "item/fileChange/requestApproval",
      id: 42,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-file",
        reason: "Write outside root",
        grantRoot: "/shared",
      },
    })

    expect(harness.server.listPendingApprovals("thread-1")).toEqual([
      expect.objectContaining({
        requestId: "approval-command",
        kind: "commandExecution",
        requestedAt: 99,
        command: "npm test",
        cwd: "/project",
        networkApprovalContext: { host: "registry.npmjs.org" },
      }),
      expect.objectContaining({
        requestId: 42,
        kind: "fileChange",
        requestedAt: 123_456,
        grantRoot: "/shared",
      }),
    ])
    expect(approvalChanges).toHaveBeenLastCalledWith(
      "thread-1",
      expect.any(Array),
    )
    expect(harness.server.listPendingApprovals("another-thread")).toEqual([])
  })

  it.each([
    ["allow", "accept"],
    ["allow_always", "acceptForSession"],
    ["deny", "decline"],
  ] as const)("maps %s to the app-server %s decision", async (ui, wire) => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send({
      method: "item/fileChange/requestApproval",
      id: `approval-${ui}`,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
      },
    })

    await harness.server.respondApproval(`approval-${ui}`, ui)
    expect(child.messages.at(-1)).toEqual({
      id: `approval-${ui}`,
      result: { decision: wire },
    })
    expect(child.messages.at(-1)).not.toHaveProperty("jsonrpc")
    expect(harness.server.listPendingApprovals("thread-1")).toEqual([])
  })

  it("enforces the decisions offered by each server request", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send({
      method: "item/commandExecution/requestApproval",
      id: "restricted-approval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        availableDecisions: ["accept", "decline"],
      },
    })

    expect(harness.server.listPendingApprovals("thread-1")).toEqual([
      expect.objectContaining({
        requestId: "restricted-approval",
        availableDecisions: ["allow", "deny"],
      }),
    ])

    const messagesBeforeResponse = child.messages.length
    await expect(
      harness.server.respondApproval("restricted-approval", "allow_always"),
    ).rejects.toThrow("allow_always is not available")
    expect(child.messages).toHaveLength(messagesBeforeResponse)

    await harness.server.respondApproval("restricted-approval", "deny")
    expect(child.messages.at(-1)).toEqual({
      id: "restricted-approval",
      result: { decision: "decline" },
    })
  })

  it("maps cancel-only requests to the shared deny action", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send({
      method: "item/commandExecution/requestApproval",
      id: "cancel-approval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        availableDecisions: ["cancel"],
      },
    })

    expect(
      harness.server.listPendingApprovals("thread-1")[0].availableDecisions,
    ).toEqual(["deny"])
    await harness.server.respondApproval("cancel-approval", "deny")
    expect(child.messages.at(-1)).toEqual({
      id: "cancel-approval",
      result: { decision: "cancel" },
    })
  })

  it("surfaces descendant approvals under every ancestor thread", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    const approvalChanges = vi.fn()
    harness.server.subscribeApprovals(approvalChanges)

    child.send({
      method: "thread/started",
      params: {
        thread: { id: "child-thread", parentThreadId: "root-thread" },
      },
    })
    child.send({
      method: "thread/started",
      params: {
        thread: { id: "grandchild-thread", parentThreadId: "child-thread" },
      },
    })
    child.send({
      method: "item/fileChange/requestApproval",
      id: "child-approval",
      params: {
        threadId: "grandchild-thread",
        turnId: "child-turn",
        itemId: "child-item",
        startedAtMs: 1,
      },
    })

    expect(harness.server.listPendingApprovals("root-thread")).toEqual([
      expect.objectContaining({
        requestId: "child-approval",
        threadId: "grandchild-thread",
      }),
    ])
    expect(harness.server.listPendingApprovals("child-thread")).toHaveLength(1)
    expect(approvalChanges).toHaveBeenCalledWith(
      "root-thread",
      expect.arrayContaining([
        expect.objectContaining({ requestId: "child-approval" }),
      ]),
    )

    const approval = harness.server.listPendingApprovals("root-thread")[0]
    await harness.server.respondApproval(approval, "allow")
    expect(child.messages.at(-1)).toEqual({
      id: "child-approval",
      result: { decision: "accept" },
    })
    expect(harness.server.listPendingApprovals("root-thread")).toEqual([])
  })

  it("clears approvals when the server resolves them", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send({
      method: "item/commandExecution/requestApproval",
      id: 77,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
      },
    })
    expect(harness.server.listPendingApprovals("thread-1")).toHaveLength(1)

    child.send({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 77 },
    })
    expect(harness.server.listPendingApprovals("thread-1")).toEqual([])
    await expect(harness.server.respondApproval(77, "allow")).rejects.toThrow(
      "no longer pending",
    )
  })
})

describe("CodexAppServer shutdown", () => {
  it("rejects pending calls, terminates the child, and stays closed", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    const pending = harness.server.call("test/pending", {})

    await harness.server.shutdown()
    await expect(pending).rejects.toThrow("client shut down")
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    await expect(harness.server.call("test/after-shutdown", {})).rejects.toThrow(
      "has been shut down",
    )
    expect(harness.spawn).toHaveBeenCalledTimes(1)
  })

  it("waits for the grace period and force-kills a SIGTERM-resistant child", async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const child = await initialize(harness)
    child.ignoreSigterm = true
    let settled = false

    const shutdown = harness.server.shutdown().then(() => { settled = true })
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    await vi.advanceTimersByTimeAsync(2_999)
    expect(settled).toBe(false)
    expect(child.kill).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await shutdown

    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"])
    expect(settled).toBe(true)
  })

  it("returns one shared promise to concurrent shutdown callers", async () => {
    const harness = createHarness()
    await initialize(harness)

    const first = harness.server.shutdown()
    const second = harness.server.shutdown()

    expect(second).toBe(first)
    await first
  })
})
