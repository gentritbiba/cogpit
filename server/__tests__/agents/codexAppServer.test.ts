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
} from "../../agents/codexAppServer"

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
  clock: { now: number }
  reportError: ReturnType<typeof vi.fn<(threadId: string, message: string) => void>>
}

const servers: CodexAppServer[] = []

function createHarness(
  options: {
    requestTimeoutMs?: number
    versionCheckIntervalMs?: number
    readInstalledVersion?: () => Promise<string | null>
  } = {},
): Harness {
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
  const clock = { now: 123_456 }
  const reportError = vi.fn<(threadId: string, message: string) => void>()
  const server = new CodexAppServer({
    reportError,
    spawn,
    requestTimeoutMs: options.requestTimeoutMs,
    clientVersion: "9.8.7",
    now: () => clock.now,
    versionCheckIntervalMs: options.versionCheckIntervalMs,
    readInstalledVersion: options.readInstalledVersion,
  })
  servers.push(server)
  return { server, children, spawn, clock, reportError }
}

async function initialize(
  harness: Harness,
  userAgent = "codex-test",
): Promise<FakeCodexProcess> {
  const promise = harness.server.start()
  const child = harness.children.at(-1)
  if (!child) throw new Error("Expected Codex child to be spawned")
  const request = child.messages[0]
  child.send({ id: request.id, result: { userAgent } })
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

describe("CodexAppServer version drift", () => {
  const OLD = "cogpit/0.151.0 (Mac OS 26.2.0; arm64)"

  it("reconnects when codex is upgraded under an idle connection", async () => {
    const readInstalledVersion = vi.fn(async () => "0.152.0")
    const harness = createHarness({ readInstalledVersion })
    const first = await initialize(harness, OLD)

    harness.clock.now += 60_000
    const restarted = harness.server.start()
    await vi.waitFor(() => expect(harness.children).toHaveLength(2))
    expect(first.kill).toHaveBeenCalledWith("SIGTERM")

    const second = harness.children[1]
    const request = requestFor(second, "initialize")
    second.send({ id: request.id, result: { userAgent: "cogpit/0.152.0 (x)" } })
    await expect(restarted).resolves.toEqual({
      userAgent: "cogpit/0.152.0 (x)",
    })
    expect(readInstalledVersion).toHaveBeenCalledTimes(1)
  })

  it("keeps the connection when the installed version still matches", async () => {
    const readInstalledVersion = vi.fn(async () => "0.151.0")
    const harness = createHarness({ readInstalledVersion })
    await initialize(harness, OLD)

    harness.clock.now += 60_000
    await expect(harness.server.start()).resolves.toEqual({ userAgent: OLD })
    expect(readInstalledVersion).toHaveBeenCalledTimes(1)
    expect(harness.spawn).toHaveBeenCalledTimes(1)
  })

  it("probes at most once per interval", async () => {
    const readInstalledVersion = vi.fn(async () => "0.151.0")
    const harness = createHarness({ readInstalledVersion })
    await initialize(harness, OLD)

    await harness.server.start()
    await harness.server.start()
    expect(readInstalledVersion).not.toHaveBeenCalled()
  })

  it("does not restart while a turn is in flight", async () => {
    const readInstalledVersion = vi.fn(async () => "0.152.0")
    const harness = createHarness({ readInstalledVersion })
    const child = await initialize(harness, OLD)

    const turn = harness.server.startTurn("thread-1", "Run the tests")
    const request = requestFor(child, "turn/start")
    child.send({
      id: request.id,
      result: { turn: { id: "turn-1", status: "inProgress", items: [] } },
    })
    await turn

    harness.clock.now += 60_000
    await harness.server.start()
    expect(readInstalledVersion).not.toHaveBeenCalled()
    expect(harness.spawn).toHaveBeenCalledTimes(1)
  })

  it("skips the probe when the app-server reports no version", async () => {
    const readInstalledVersion = vi.fn(async () => "0.152.0")
    const harness = createHarness({ readInstalledVersion })
    await initialize(harness)

    harness.clock.now += 60_000
    await harness.server.start()
    expect(readInstalledVersion).not.toHaveBeenCalled()
    expect(harness.spawn).toHaveBeenCalledTimes(1)
  })

  it("stays connected when the version probe fails", async () => {
    const readInstalledVersion = vi.fn(async () => null)
    const harness = createHarness({ readInstalledVersion })
    await initialize(harness, OLD)

    harness.clock.now += 60_000
    await expect(harness.server.start()).resolves.toEqual({ userAgent: OLD })
    expect(harness.spawn).toHaveBeenCalledTimes(1)
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

    const approval = harness.server.listPendingApprovals("root-thread")[0]
    await harness.server.respondApproval(approval, "allow")
    expect(child.messages.at(-1)).toEqual({
      id: "child-approval",
      result: { decision: "accept" },
    })
    expect(harness.server.listPendingApprovals("root-thread")).toEqual([])
  })

  it("carries a terminal-input approval as its own kind and denies it by cancelling", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send({
      method: "item/commandExecution/requestApproval",
      id: "stdin-approval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        kind: "writeStdin",
        approvalId: "callback-1",
        command: "write_stdin --session-id 12 'y\n'",
        availableDecisions: ["accept", "cancel"],
      },
    })

    expect(harness.server.listPendingApprovals("thread-1")).toEqual([
      expect.objectContaining({
        requestId: "stdin-approval",
        kind: "writeStdin",
        approvalId: "callback-1",
        command: "write_stdin --session-id 12 'y\n'",
        availableDecisions: ["allow", "deny"],
      }),
    ])

    await harness.server.respondApproval("stdin-approval", "deny")
    expect(child.messages.at(-1)).toEqual({
      id: "stdin-approval",
      result: { decision: "cancel" },
    })
  })

  it("treats a command approval without a kind as a command", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send({
      method: "item/commandExecution/requestApproval",
      id: "plain-approval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", kind: "command" },
    })

    expect(harness.server.listPendingApprovals("thread-1")[0].kind).toBe("commandExecution")
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

describe("CodexAppServer MCP tool-call approvals", () => {
  function toolCallRequest(id: string | number, meta: JsonObject = {}, params: JsonObject = {}): JsonObject {
    return {
      method: "mcpServer/elicitation/request",
      id,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "github",
        mode: "form",
        message: 'Allow the github MCP server to run tool "create_issue"?',
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call", ...meta },
        ...params,
      },
    }
  }

  it("surfaces a tool-call approval that has neither an item nor a turn", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(toolCallRequest(7, {
      persist: "session",
      tool_title: "Create issue",
      tool_description: "Opens an issue",
      tool_params: { title: "Bug", repo: "acme/app" },
      tool_params_display: [
        { name: "repo", value: "acme/app", display_name: "Repository" },
        { name: "title", value: "Bug", display_name: "Title" },
      ],
    }, { turnId: null }))

    const [approval] = harness.server.listPendingApprovals("thread-1")
    expect(approval).toMatchObject({
      requestId: 7,
      kind: "mcpToolCall",
      method: "mcpServer/elicitation/request",
      threadId: "thread-1",
      turnId: null,
      requestedAt: 123_456,
      availableDecisions: ["allow", "allow_always", "deny"],
      mcpToolCall: {
        serverName: "github",
        message: 'Allow the github MCP server to run tool "create_issue"?',
        toolTitle: "Create issue",
        toolDescription: "Opens an issue",
        toolParams: { Repository: "acme/app", Title: "Bug" },
      },
    })
    expect(approval.itemId).toBeUndefined()
    expect(harness.server.listPendingElicitations("thread-1")).toEqual([])
    expect(child.messages.some((message) => message.id === 7)).toBe(false)
  })

  it.each([
    ["allow", { action: "accept", content: null }],
    ["allow_always", { action: "accept", content: null, _meta: { persist: "session" } }],
    ["deny", { action: "decline" }],
  ] as const)("answers %s with the elicitation response Codex parses", async (decision, result) => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(toolCallRequest("tool-approval", { persist: ["session", "always"] }))

    await harness.server.respondApproval("tool-approval", decision)

    expect(child.messages.at(-1)).toEqual({ id: "tool-approval", result })
    expect(harness.server.listPendingApprovals("thread-1")).toEqual([])
  })

  it.each([
    ["no remember option", {}],
    ["only a persistent grant", { persist: "always" }],
    ["a list without a session grant", { persist: ["always"] }],
  ])("does not offer a session grant with %s", async (_label, meta) => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(toolCallRequest("tool-approval", meta))

    expect(harness.server.listPendingApprovals("thread-1")[0].availableDecisions)
      .toEqual(["allow", "deny"])
    const sent = child.messages.length
    await expect(harness.server.respondApproval("tool-approval", "allow_always"))
      .rejects.toThrow("allow_always is not available")
    expect(child.messages).toHaveLength(sent)
  })

  it("falls back to the raw arguments when Codex sends no display list", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(toolCallRequest("tool-approval", {
      connector_name: "Gmail",
      tool_params: { to: "a@example.com" },
    }))

    expect(harness.server.listPendingApprovals("thread-1")[0].mcpToolCall).toEqual({
      serverName: "github",
      message: 'Allow the github MCP server to run tool "create_issue"?',
      connectorName: "Gmail",
      toolParams: { to: "a@example.com" },
    })
  })

  it("drops a tool-call approval with its turn, its thread, or the server's own resolution", async () => {
    const harness = createHarness()
    const child = await initialize(harness)

    child.send(toolCallRequest("by-turn"))
    child.send(toolCallRequest("no-turn", {}, { turnId: null }))
    child.send(toolCallRequest("other-turn", {}, { turnId: "turn-2" }))
    child.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    })
    expect(harness.server.listPendingApprovals("thread-1").map((a) => a.requestId))
      .toEqual(["other-turn"])

    child.send({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "other-turn" },
    })
    expect(harness.server.listPendingApprovals("thread-1")).toEqual([])

    child.send(toolCallRequest("by-thread"))
    child.send({ method: "thread/closed", params: { threadId: "thread-1" } })
    expect(harness.server.listPendingApprovals("thread-1")).toEqual([])
    expect(harness.server.listApprovalThreadIds()).toEqual([])
  })

  it.each([
    [
      "a browser_auth approval",
      { codex_approval_kind: "browser_auth" },
      {},
      'Cogpit has no prompt for "browser_auth" approvals',
    ],
    [
      "a tool_suggestion approval",
      { codex_approval_kind: "tool_suggestion" },
      {},
      'Cogpit has no prompt for "tool_suggestion" approvals',
    ],
    [
      "a tool-call approval with fields to fill in",
      {},
      { requestedSchema: { type: "object", properties: { note: { type: "string" } } } },
      "Cogpit cannot show a tool-call approval that also asks for input",
    ],
    [
      "a tool-call approval sent as a link",
      {},
      { mode: "url", url: "https://example.com", elicitationId: "e-1" },
      "Cogpit cannot show a tool-call approval that also asks for input",
    ],
  ])("declines %s rather than approving something it cannot show", async (_label, meta, params, reason) => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(toolCallRequest("odd-approval", meta, params))

    await vi.waitFor(() => {
      expect(child.messages).toContainEqual({
        id: "odd-approval",
        result: { action: "decline" },
      })
    })
    expect(harness.server.listPendingApprovals("thread-1")).toEqual([])
    expect(harness.server.listPendingElicitations("thread-1")).toEqual([])
    expect(harness.reportError).toHaveBeenCalledWith(
      "thread-1",
      `Declined a request from MCP server "github": ${reason}.`,
    )
  })
})

describe("CodexAppServer MCP elicitations", () => {
  function formRequest(id: string | number, params: JsonObject = {}): JsonObject {
    return {
      method: "mcpServer/elicitation/request",
      id,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "tracker",
        mode: "form",
        message: "Which project?",
        requestedSchema: {
          type: "object",
          properties: {
            project: { type: "string", title: "Project" },
            priority: {
              type: "string",
              oneOf: [
                { const: "p1", title: "Urgent" },
                { const: "p2", title: "Normal" },
              ],
            },
            notify: { type: "boolean", default: true },
          },
          required: ["project"],
        },
        ...params,
      },
    }
  }

  function urlRequest(id: string, url: string): JsonObject {
    return {
      method: "mcpServer/elicitation/request",
      id,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "tracker",
        mode: "url",
        message: "Sign in to continue",
        url,
        elicitationId: "sign-in-1",
      },
    }
  }

  it("parks a form elicitation as fields the prompt can draw", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(formRequest(11))

    expect(harness.server.listPendingElicitations("thread-1")).toEqual([{
      requestId: 11,
      threadId: "thread-1",
      turnId: "turn-1",
      requestedAt: 123_456,
      serverName: "tracker",
      mode: "form",
      message: "Which project?",
      fields: [
        { name: "project", label: "Project", type: "string", required: true },
        {
          name: "priority",
          label: "priority",
          type: "enum",
          required: false,
          options: [
            { value: "p1", label: "Urgent" },
            { value: "p2", label: "Normal" },
          ],
        },
        { name: "notify", label: "notify", type: "boolean", required: false, defaultValue: true },
      ],
    }])
    expect(harness.server.listPendingApprovals("thread-1")).toEqual([])
    expect(harness.server.listElicitationThreadIds()).toEqual(["thread-1"])
    expect(child.messages.some((message) => message.id === 11)).toBe(false)
  })

  it("accepts a form with the submitted content", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(formRequest("form-1"))

    await harness.server.respondElicitation("form-1", {
      action: "accept",
      content: { project: "cogpit", notify: false },
    })

    expect(child.messages.at(-1)).toEqual({
      id: "form-1",
      result: { action: "accept", content: { project: "cogpit", notify: false } },
    })
    expect(harness.server.listPendingElicitations("thread-1")).toEqual([])
    await expect(harness.server.respondElicitation("form-1", { action: "decline" }))
      .rejects.toThrow("no longer pending")
  })

  it.each(["decline", "cancel"] as const)("answers %s without content", async (action) => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(formRequest("form-1"))

    await harness.server.respondElicitation("form-1", { action })

    expect(child.messages.at(-1)).toEqual({ id: "form-1", result: { action } })
    expect(harness.server.listElicitationThreadIds()).toEqual([])
  })

  it("parks a link elicitation and accepts it with no content", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(urlRequest("url-1", "https://tracker.example/sign-in"))

    expect(harness.server.listPendingElicitations("thread-1")).toEqual([{
      requestId: "url-1",
      threadId: "thread-1",
      turnId: "turn-1",
      requestedAt: 123_456,
      serverName: "tracker",
      mode: "url",
      message: "Sign in to continue",
      url: "https://tracker.example/sign-in",
      fields: [],
    }])

    await harness.server.respondElicitation("url-1", { action: "accept" })
    expect(child.messages.at(-1)).toEqual({
      id: "url-1",
      result: { action: "accept", content: null },
    })
  })

  it.each([
    [
      "device verification",
      { mode: "openai/userVerification", title: "Confirm", description: "Touch ID", challenge: "abc" },
      "Cogpit cannot verify the user on this device",
    ],
    [
      "an experimental form",
      { mode: "openai/form", requestedSchema: { anything: true } },
      'Cogpit has no prompt for "openai/form" requests',
    ],
    [
      "the renamed experimental form",
      { mode: "openaiForm", requestedSchema: { anything: true } },
      'Cogpit has no prompt for "openaiForm" requests',
    ],
    [
      "a field it cannot draw",
      {
        requestedSchema: {
          type: "object",
          properties: { tags: { type: "array", items: { type: "string", enum: ["a"] } } },
        },
      },
      'Cogpit renders text, number, checkbox and choice fields only, and "tags" is an array, which Cogpit cannot render',
    ],
  ])("declines %s instead of parking it", async (_label, params, reason) => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(formRequest("unanswerable", params))

    await vi.waitFor(() => {
      expect(child.messages).toContainEqual({
        id: "unanswerable",
        result: { action: "decline" },
      })
    })
    expect(harness.server.listPendingElicitations("thread-1")).toEqual([])
    expect(harness.reportError).toHaveBeenCalledWith(
      "thread-1",
      `Declined a request from MCP server "tracker": ${reason}.`,
    )
  })

  it("declines a link that is not a web address", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(urlRequest("url-1", "file:///etc/passwd"))

    await vi.waitFor(() => {
      expect(child.messages).toContainEqual({ id: "url-1", result: { action: "decline" } })
    })
    expect(harness.server.listPendingElicitations("thread-1")).toEqual([])
  })

  it("rejects an elicitation that names no thread or server", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(formRequest("nameless", { serverName: undefined }))

    await vi.waitFor(() => {
      expect(child.messages).toContainEqual({
        id: "nameless",
        error: {
          code: -32602,
          message: "Invalid params for Codex server request mcpServer/elicitation/request",
        },
      })
    })
    expect(harness.server.listPendingElicitations("thread-1")).toEqual([])
  })

  it("drops an elicitation with its turn, its thread, or the server's own resolution", async () => {
    const harness = createHarness()
    const child = await initialize(harness)

    child.send(formRequest("by-turn"))
    child.send(formRequest("no-turn", { turnId: null }))
    child.send(formRequest("other-turn", { turnId: "turn-2" }))
    child.send({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    })
    expect(harness.server.listPendingElicitations("thread-1").map((e) => e.requestId))
      .toEqual(["other-turn"])

    child.send({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "other-turn" },
    })
    expect(harness.server.listPendingElicitations("thread-1")).toEqual([])

    child.send(formRequest("by-thread"))
    child.send({ method: "thread/closed", params: { threadId: "thread-1" } })
    expect(harness.server.listPendingElicitations("thread-1")).toEqual([])
    expect(harness.server.listElicitationThreadIds()).toEqual([])
  })

  it("drops parked elicitations when the connection dies", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send(formRequest("form-1"))
    expect(harness.server.listPendingElicitations("thread-1")).toHaveLength(1)

    child.close()

    expect(harness.server.listPendingElicitations("thread-1")).toEqual([])
    await expect(harness.server.respondElicitation("form-1", { action: "decline" }))
      .rejects.toThrow("no longer pending")
  })

  it("lists a subagent's elicitation under every ancestor thread", async () => {
    const harness = createHarness()
    const child = await initialize(harness)
    child.send({
      method: "thread/started",
      params: { thread: { id: "child-thread", parentThreadId: "root-thread" } },
    })
    child.send(formRequest("child-form", { threadId: "child-thread" }))

    expect(harness.server.listElicitationThreadIds()).toEqual(["child-thread", "root-thread"])
    expect(harness.server.listPendingElicitations("root-thread")).toEqual([
      expect.objectContaining({ requestId: "child-form", threadId: "child-thread" }),
    ])
    expect(harness.server.listPendingElicitations("unrelated-thread")).toEqual([])
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
