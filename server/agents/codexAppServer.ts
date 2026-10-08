import { validateCodexRequest } from "./codexProtocolValidation"
import { spawn as spawnChild } from "node:child_process"
import { createInterface } from "node:readline"
import type { Interface as ReadlineInterface } from "node:readline"
import packageJson from "../../package.json"
import { isRecord } from "../../shared/objects"
import {
  CODEX_CLIENT_CAPABILITIES,
  COMMAND_APPROVAL_METHOD,
  CURRENT_TIME_METHOD,
  FILE_APPROVAL_METHOD,
  MCP_ELICITATION_METHOD,
} from "./codexAppServerProtocol"
import type {
  ApprovalDecision,
  CodexAppServerOptions,
  CodexAppServerProcess,
  CodexAppServerSpawn,
  CodexNotification,
  CodexNotificationListener,
  CodexThread,
  ElicitationResponse,
  InitializeResult,
  JsonObject,
  JsonRpcId,
  PendingApproval,
  PendingElicitation,
  ThreadGoalClearResponse,
  ThreadGoalResponse,
  ThreadGoalSetParams,
  ThreadResponse,
  ThreadResumeParams,
  ThreadStartParams,
  TurnResponse,
  TurnStartParams,
  TurnSteerParams,
  TurnSteerResponse,
  UserInput,
} from "./codexAppServerProtocol"
import {
  normalizeAvailableDecisions,
  wireApprovalResult,
} from "./codexApprovalCodec"
import { routeElicitation, wireElicitationResponse } from "./codexElicitation"
import { PendingRequests } from "./codexPendingRequests"
import { resolveAgentCommand } from "../lib/binaryResolver"
import { cogpitAgentEnv } from "../browser/agentEnv"
import { NO_COGPIT_SESSION } from "../browser/paths"
import { forwardCodexStreamNotification } from "../lib/codexStreamAdapter"
import { publishError } from "../lib/streamBus"
import { codexQuestions } from "./codexQuestions"
import {
  parseUserAgentVersion,
  readInstalledCodexVersion,
} from "../lib/codexVersion"

export { CODEX_CLIENT_CAPABILITIES } from "./codexAppServerProtocol"
export type * from "./codexAppServerProtocol"

export class CodexAppServerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CodexAppServerError"
  }
}

export class CodexAppServerRpcError extends CodexAppServerError {
  readonly code: number
  readonly data: unknown
  readonly method: string

  constructor(
    method: string,
    error: { code?: unknown; message?: unknown; data?: unknown },
  ) {
    const code = typeof error.code === "number" ? error.code : -1
    const message =
      typeof error.message === "string" ? error.message : "Unknown RPC error"
    super(`Codex app-server ${method} failed (${code}): ${message}`)
    this.name = "CodexAppServerRpcError"
    this.code = code
    this.data = error.data
    this.method = method
  }
}

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof globalThis.setTimeout> | null
}

interface RpcResponse {
  id: JsonRpcId
  result?: unknown
  error?: { code?: unknown; message?: unknown; data?: unknown }
}

interface ServerRequest {
  id: JsonRpcId
  method: string
  params?: unknown
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_VERSION_CHECK_INTERVAL_MS = 60_000
const MAX_STDERR_LENGTH = 16_000
const SHUTDOWN_GRACE_MS = 3_000
const FORCE_KILL_GRACE_MS = 1_000

const defaultSpawn: CodexAppServerSpawn = (command, args, options) =>
  spawnChild(command, args, options)

function isRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number"
}

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key]
  return typeof value === "string" ? value : undefined
}

function textInput(input: string | UserInput[]): UserInput[] {
  return typeof input === "string"
    ? [{ type: "text", text: input, text_elements: [] }]
    : input
}

/**
 * Persistent JSONL client for `codex app-server --stdio`.
 *
 * One child is kept alive and shared by all calls. If it exits, in-flight
 * requests are rejected and the next call starts a fresh connection. An idle
 * connection also reconnects when the `codex` on disk has been upgraded past
 * the running child — see {@link beginVersionCheck}.
 */
export class CodexAppServer {
  private readonly spawn: CodexAppServerSpawn
  private readonly command: string
  private readonly requestTimeoutMs: number
  private readonly clientVersion: string
  private readonly now: () => number
  private readonly setTimer: typeof globalThis.setTimeout
  private readonly clearTimer: typeof globalThis.clearTimeout
  private readonly versionCheckIntervalMs: number
  private readonly readInstalledVersion: () => Promise<string | null>
  private readonly reportError: (threadId: string, message: string) => void

  private child: CodexAppServerProcess | null = null
  private reader: ReadlineInterface | null = null
  private startPromise: Promise<InitializeResult> | null = null
  private initializeResult: InitializeResult | null = null
  private shuttingDown = false
  private shutdownPromise: Promise<void> | null = null
  private nextRequestId = 1
  private stderr = ""
  private runningVersion: string | null = null
  private lastVersionCheckAt = 0
  private versionCheck: Promise<boolean> | null = null

  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>()
  private readonly notificationListeners = new Set<CodexNotificationListener>()
  private readonly activeTurnIds = new Map<string, string>()
  private readonly completedTurns = new Map<string, { isError: boolean; message?: string }>()
  private readonly completionWaiters = new Map<string, Array<{ resolve: (result: { isError: boolean; message?: string }) => void; reject: (error: Error) => void }>>()
  private readonly parentThreadIds = new Map<string, string>()
  private readonly approvals = new PendingRequests<PendingApproval>()
  private readonly elicitations = new PendingRequests<PendingElicitation>()

  constructor(options: CodexAppServerOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn
    this.command = options.command ?? process.env.COGPIT_PROVIDER_EXECUTABLE ?? "codex"
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.clientVersion = options.clientVersion ?? packageJson.version
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimeout ?? globalThis.setTimeout
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout
    this.versionCheckIntervalMs =
      options.versionCheckIntervalMs ?? DEFAULT_VERSION_CHECK_INTERVAL_MS
    this.readInstalledVersion =
      options.readInstalledVersion ??
      (() => readInstalledCodexVersion(this.command))
    this.reportError = options.reportError ?? (() => undefined)
  }

  start(): Promise<InitializeResult> {
    const versionCheck = this.beginVersionCheck()
    if (!versionCheck) return this.connect()
    return versionCheck.then((changed) =>
      changed ? this.restart() : this.connect(),
    )
  }

  /**
   * Upgrading `codex` swaps the vendored binaries under the running
   * app-server. The stale process then speaks an older protocol to the
   * freshly installed code-mode host, and every shell command comes back as
   * `failed to decode code-mode IPC frame` even though it ran fine. Probe the
   * installed version while idle so the next session reconnects instead.
   *
   * Returns null when there is nothing to check, which keeps the common path
   * synchronous — callers rely on `start()` spawning before it yields.
   */
  private beginVersionCheck(): Promise<boolean> | null {
    if (this.versionCheck) return this.versionCheck
    if (this.shuttingDown) return null
    if (!this.child || !this.initializeResult) return null
    // An app-server that did not report its version gives us nothing to
    // compare, and restarting mid-turn would kill an in-flight conversation.
    if (!this.runningVersion) return null
    if (this.activeTurnIds.size > 0) return null
    const now = this.now()
    if (now - this.lastVersionCheckAt < this.versionCheckIntervalMs) return null
    this.lastVersionCheckAt = now

    const running = this.runningVersion
    const check = this.readInstalledVersion()
      .catch(() => null)
      .then((installed) => {
        if (installed === null || installed === running) return false
        console.warn(
          `Codex was upgraded from ${running} to ${installed}; restarting the app-server.`,
        )
        return true
      })
      .finally(() => {
        if (this.versionCheck === check) this.versionCheck = null
      })
    this.versionCheck = check
    return check
  }

  private connect(): Promise<InitializeResult> {
    if (this.shuttingDown) {
      return Promise.reject(
        new CodexAppServerError("Codex app-server client has been shut down"),
      )
    }
    if (this.child && this.initializeResult) {
      return Promise.resolve(this.initializeResult)
    }
    if (this.startPromise) return this.startPromise

    let child: CodexAppServerProcess
    try {
      const cli = resolveAgentCommand(this.command, ["app-server", "--stdio"])
      child = this.spawn(cli.command, cli.args, {
        stdio: ["pipe", "pipe", "pipe"],
        // One process serves every thread, so no single session owns it.
        env: cogpitAgentEnv(process.env, NO_COGPIT_SESSION),
        ...cli.spawnOptions,
      })
    } catch (error) {
      return Promise.reject(
        new CodexAppServerError("Failed to spawn Codex app-server", {
          cause: error,
        }),
      )
    }

    this.child = child
    this.stderr = ""
    this.bindProcess(child)

    const starting = this.initialize(child)
    this.startPromise = starting
    void starting.then(
      () => {
        if (this.startPromise === starting) this.startPromise = null
      },
      (error: unknown) => {
        if (this.startPromise === starting) this.startPromise = null
        if (this.child === child) {
          this.disconnect(
            error instanceof Error
              ? error
              : new CodexAppServerError(String(error)),
            child,
            true,
          )
        }
      },
    )
    return starting
  }

  async restart(): Promise<InitializeResult> {
    if (this.shuttingDown) {
      throw new CodexAppServerError("Codex app-server client has been shut down")
    }
    const child = this.child
    if (child) {
      await this.terminateChild(
        child,
        new CodexAppServerError("Codex app-server connection restarted"),
      )
    }
    return this.connect()
  }

  call<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    try { validateCodexRequest(method, params) } catch (error) { return Promise.reject(error) }
    const connectedChild = this.child
    if (connectedChild && this.initializeResult) {
      return this.request<T>(
        connectedChild,
        method,
        params,
        options.timeoutMs,
      )
    }
    return this.start().then(() => {
      const child = this.child
      if (!child || !this.initializeResult) {
        throw new CodexAppServerError("Codex app-server is not connected")
      }
      return this.request<T>(child, method, params, options.timeoutMs)
    })
  }

  async startThread(params: ThreadStartParams = {}): Promise<ThreadResponse> {
    const response = await this.call<ThreadResponse>("thread/start", params)
    this.rememberThread(response.thread)
    return response
  }

  resumeThread(params: ThreadResumeParams): Promise<ThreadResponse>
  resumeThread(
    threadId: string,
    options?: Omit<ThreadResumeParams, "threadId">,
  ): Promise<ThreadResponse>
  async resumeThread(
    threadOrParams: string | ThreadResumeParams,
    options: Omit<ThreadResumeParams, "threadId"> = {},
  ): Promise<ThreadResponse> {
    const params =
      typeof threadOrParams === "string"
        ? { ...options, threadId: threadOrParams }
        : threadOrParams
    const response = await this.call<ThreadResponse>("thread/resume", params)
    this.rememberThread(response.thread)
    return response
  }

  startTurn(params: TurnStartParams): Promise<TurnResponse>
  startTurn(
    threadId: string,
    input: string | UserInput[],
    options?: Omit<TurnStartParams, "threadId" | "input">,
  ): Promise<TurnResponse>
  async startTurn(
    threadOrParams: string | TurnStartParams,
    input?: string | UserInput[],
    options: Omit<TurnStartParams, "threadId" | "input"> = {},
  ): Promise<TurnResponse> {
    const params =
      typeof threadOrParams === "string"
        ? {
            ...options,
            threadId: threadOrParams,
            input: textInput(input ?? []),
          }
        : threadOrParams
    const response = await this.call<TurnResponse>("turn/start", params)
    if (response.turn?.id) {
      this.activeTurnIds.set(params.threadId, response.turn.id)
    }
    return response
  }

  steerTurn(params: TurnSteerParams): Promise<TurnSteerResponse>
  steerTurn(
    threadId: string,
    input: string | UserInput[],
    expectedTurnId?: string,
  ): Promise<TurnSteerResponse>
  async steerTurn(
    threadOrParams: string | TurnSteerParams,
    input?: string | UserInput[],
    expectedTurnId?: string,
  ): Promise<TurnSteerResponse> {
    const params: TurnSteerParams =
      typeof threadOrParams === "string"
        ? {
            threadId: threadOrParams,
            input: textInput(input ?? []),
            expectedTurnId,
          }
        : { ...threadOrParams }
    params.expectedTurnId ??= this.activeTurnIds.get(params.threadId)
    if (!params.expectedTurnId) {
      throw new CodexAppServerError(
        `No active turn is known for thread ${params.threadId}`,
      )
    }
    const response = await this.call<TurnSteerResponse>("turn/steer", params)
    this.activeTurnIds.set(params.threadId, response.turnId)
    return response
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<JsonObject> {
    const targetTurnId = turnId ?? this.activeTurnIds.get(threadId)
    if (!targetTurnId) {
      throw new CodexAppServerError(
        `No active turn is known for thread ${threadId}`,
      )
    }
    return this.call("turn/interrupt", {
      threadId,
      turnId: targetTurnId,
    })
  }

  getGoal(threadId: string): Promise<ThreadGoalResponse> {
    return this.call("thread/goal/get", { threadId })
  }

  setGoal(params: ThreadGoalSetParams): Promise<ThreadGoalResponse>
  setGoal(
    threadId: string,
    goal: Omit<ThreadGoalSetParams, "threadId">,
  ): Promise<ThreadGoalResponse>
  setGoal(
    threadOrParams: string | ThreadGoalSetParams,
    goal: Omit<ThreadGoalSetParams, "threadId"> = {},
  ): Promise<ThreadGoalResponse> {
    const params =
      typeof threadOrParams === "string"
        ? { ...goal, threadId: threadOrParams }
        : threadOrParams
    return this.call("thread/goal/set", params)
  }

  clearGoal(threadId: string): Promise<ThreadGoalClearResponse> {
    return this.call("thread/goal/clear", { threadId })
  }

  getActiveTurnId(threadId: string): string | undefined {
    return this.activeTurnIds.get(threadId)
  }

  /** Snapshot every active native turn, including turns owned by subagents. */
  listActiveTurns(): Array<{ threadId: string; turnId: string }> {
    return [...this.activeTurnIds.entries()].map(([threadId, turnId]) => ({
      threadId,
      turnId,
    }))
  }

  /**
   * Thread ids that currently hold at least one pending approval.
   *
   * Lets callers enumerate approvals across every thread; `listPendingApprovals`
   * only answers for a thread you already know about.
   */
  listApprovalThreadIds(): string[] {
    return this.approvals.threadIds()
  }

  listPendingApprovals(threadId: string): PendingApproval[] {
    return this.approvals
      .list((approvalThreadId) =>
        this.isThreadOrDescendant(approvalThreadId, threadId),
      )
      .map((approval) => ({
        ...approval,
        availableDecisions: [...approval.availableDecisions],
        params: { ...approval.params },
      }))
  }

  /**
   * Threads a pending elicitation is listed under: the one that asked and each
   * of its ancestors, so a subagent's prompt reaches the session that owns it.
   */
  listElicitationThreadIds(): string[] {
    return [
      ...new Set(
        this.elicitations
          .threadIds()
          .flatMap((threadId) => this.threadLineage(threadId)),
      ),
    ]
  }

  listPendingElicitations(threadId: string): PendingElicitation[] {
    return this.elicitations.list((elicitationThreadId) =>
      this.isThreadOrDescendant(elicitationThreadId, threadId),
    )
  }

  async respondApproval(
    requestOrApproval: JsonRpcId | PendingApproval,
    decision: ApprovalDecision,
  ): Promise<void> {
    const requestId =
      typeof requestOrApproval === "object"
        ? requestOrApproval.requestId
        : requestOrApproval
    const approval = this.approvals.get(requestId)
    if (!approval) {
      throw new CodexAppServerError(
        `Approval request ${String(requestId)} is no longer pending`,
      )
    }
    if (!approval.availableDecisions.includes(decision)) {
      throw new CodexAppServerError(
        `Decision ${decision} is not available for approval request ${String(requestId)}`,
      )
    }
    const result = wireApprovalResult(approval, decision)
    if (result === undefined) {
      throw new CodexAppServerError(
        `Decision ${decision} cannot be represented for approval request ${String(requestId)}`,
      )
    }
    await this.answerServerRequest(requestId, result, "approval")
    this.approvals.remove(requestId)
  }

  async respondElicitation(
    requestId: JsonRpcId,
    response: ElicitationResponse,
  ): Promise<void> {
    if (!this.elicitations.get(requestId)) {
      throw new CodexAppServerError(
        `Elicitation request ${String(requestId)} is no longer pending`,
      )
    }
    await this.answerServerRequest(
      requestId,
      wireElicitationResponse(response),
      "elicitation",
    )
    this.elicitations.remove(requestId)
  }

  private async answerServerRequest(
    requestId: JsonRpcId,
    result: JsonObject,
    kind: "approval" | "elicitation",
  ): Promise<void> {
    const child = this.child
    if (!child || !this.initializeResult) {
      throw new CodexAppServerError("Codex app-server is not connected")
    }
    try {
      await this.writeMessage(child, { id: requestId, result })
    } catch (error) {
      const connectionError = new CodexAppServerError(
        `Failed to respond to Codex ${kind} request`,
        { cause: error },
      )
      this.disconnect(connectionError, child, true)
      throw connectionError
    }
  }

  subscribe(listener: CodexNotificationListener): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  waitForCompletion(threadId: string, turnId: string): Promise<{ isError: boolean; message?: string }> {
    const key = JSON.stringify([threadId, turnId])
    const completed = this.completedTurns.get(key)
    if (completed) return Promise.resolve(completed)
    if (!this.child) return Promise.reject(new CodexAppServerError("Codex disconnected before completion"))
    return new Promise((resolve, reject) => {
      const waiting = this.completionWaiters.get(key) ?? []
      waiting.push({ resolve, reject })
      this.completionWaiters.set(key, waiting)
    })
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shuttingDown = true
    this.shutdownPromise = (async () => {
      const error = new CodexAppServerError("Codex app-server client shut down")
      const child = this.child
      this.notificationListeners.clear()
      if (child) {
        await this.terminateChild(child, error)
      } else {
        this.rejectPending(error)
        this.clearRuntimeState()
      }
    })()
    return this.shutdownPromise
  }

  private async initialize(
    child: CodexAppServerProcess,
  ): Promise<InitializeResult> {
    try {
      validateCodexRequest("initialize", { clientInfo: { name: "cogpit", title: "Cogpit", version: this.clientVersion }, capabilities: CODEX_CLIENT_CAPABILITIES })
      const result = await this.request<InitializeResult>(
        child,
        "initialize",
        {
          clientInfo: {
            name: "cogpit",
            title: "Cogpit",
            version: this.clientVersion,
          },
          capabilities: CODEX_CLIENT_CAPABILITIES,
        },
        this.requestTimeoutMs,
      )
      if (this.child !== child) {
        throw new CodexAppServerError(
          "Codex app-server connection changed during initialization",
        )
      }
      await this.writeMessage(child, { method: "initialized", params: {} })
      this.initializeResult = result
      this.runningVersion = parseUserAgentVersion(result.userAgent)
      this.lastVersionCheckAt = this.now()
      return result
    } catch (error) {
      if (error instanceof Error) throw error
      throw new CodexAppServerError(String(error))
    }
  }

  private bindProcess(child: CodexAppServerProcess): void {
    const reader = createInterface({ input: child.stdout })
    this.reader = reader
    reader.on("line", (line) => {
      if (this.child !== child) return
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch (error) {
        this.disconnect(
          new CodexAppServerError("Codex app-server emitted invalid JSON", {
            cause: error,
          }),
          child,
          true,
        )
        return
      }
      this.handleMessage(message)
    })

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string | Buffer) => {
      if (this.child !== child) return
      this.stderr += chunk.toString()
      if (this.stderr.length > MAX_STDERR_LENGTH) {
        this.stderr = this.stderr.slice(-MAX_STDERR_LENGTH)
      }
    })

    child.on("error", (error) => {
      if (this.child !== child) return
      this.disconnect(
        new CodexAppServerError("Codex app-server process failed", {
          cause: error,
        }),
        child,
        false,
      )
    })
    child.on("close", (code, signal) => {
      if (this.child !== child) return
      const detail = signal
        ? `signal ${signal}`
        : `code ${code === null ? "unknown" : code}`
      const stderr = this.stderr.trim()
      this.disconnect(
        new CodexAppServerError(
          `Codex app-server exited with ${detail}${stderr ? `: ${stderr}` : ""}`,
        ),
        child,
        false,
      )
    })
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return
    if (isRpcId(message.id) && typeof message.method === "string") {
      this.handleServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      })
      return
    }
    if (
      isRpcId(message.id) &&
      (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
    ) {
      this.handleResponse(message as unknown as RpcResponse)
      return
    }
    if (typeof message.method === "string" && !Object.hasOwn(message, "id")) {
      this.handleNotification({
        method: message.method,
        params: message.params,
      })
    }
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pendingRequests.get(response.id)
    if (!pending) return
    this.pendingRequests.delete(response.id)
    if (pending.timer) this.clearTimer(pending.timer)
    if (response.error) {
      pending.reject(new CodexAppServerRpcError(pending.method, response.error))
    } else {
      pending.resolve(response.result)
    }
  }

  private handleServerRequest(request: ServerRequest): void {
    if (request.method === CURRENT_TIME_METHOD) {
      if (!isRecord(request.params) || !stringField(request.params, "threadId")) {
        this.rejectInvalidParams(request)
        return
      }
      this.respondServerResult(request.id, {
        currentTimeAt: Math.floor(this.now() / 1000),
      })
      return
    }

    if (
      request.method !== COMMAND_APPROVAL_METHOD &&
      request.method !== FILE_APPROVAL_METHOD &&
      request.method !== MCP_ELICITATION_METHOD
    ) {
      this.respondServerError(
        request.id,
        -32601,
        `Unsupported Codex server request: ${request.method}`,
      )
      return
    }
    if (!isRecord(request.params)) {
      this.rejectInvalidParams(request)
      return
    }
    if (request.method === MCP_ELICITATION_METHOD) {
      this.handleElicitation(request, request.params)
      return
    }
    const threadId = stringField(request.params, "threadId")
    const turnId = stringField(request.params, "turnId")
    const itemId = stringField(request.params, "itemId")
    if (!threadId || !turnId || !itemId) {
      this.rejectInvalidParams(request)
      return
    }

    const requestedAtValue = request.params.startedAtMs
    this.approvals.store({
      requestId: request.id,
      kind:
        request.method === FILE_APPROVAL_METHOD
          ? "fileChange"
          : request.params.kind === "writeStdin"
            ? "writeStdin"
            : "commandExecution",
      method: request.method,
      threadId,
      turnId,
      itemId,
      requestedAt:
        typeof requestedAtValue === "number" ? requestedAtValue : this.now(),
      reason: stringField(request.params, "reason"),
      command: stringField(request.params, "command"),
      cwd: stringField(request.params, "cwd"),
      grantRoot: stringField(request.params, "grantRoot"),
      approvalId: stringField(request.params, "approvalId"),
      networkApprovalContext: request.params.networkApprovalContext,
      availableDecisions: normalizeAvailableDecisions(
        request.params.availableDecisions,
      ),
      params: { ...request.params },
    })
  }

  /**
   * Keyed by the JSON-RPC id alone: an elicitation has no item, and its turn is
   * only the app-server's best guess.
   */
  private handleElicitation(request: ServerRequest, params: JsonObject): void {
    const threadId = stringField(params, "threadId")
    const serverName = stringField(params, "serverName")
    if (!threadId || !serverName) {
      this.rejectInvalidParams(request)
      return
    }
    const pending = {
      requestId: request.id,
      threadId,
      turnId: stringField(params, "turnId") ?? null,
      requestedAt: this.now(),
    }
    const routed = routeElicitation(params)
    if (routed.route === "approval") {
      this.approvals.store({
        ...pending,
        kind: "mcpToolCall",
        method: MCP_ELICITATION_METHOD,
        mcpToolCall: { serverName, ...routed.toolCall },
        availableDecisions: routed.availableDecisions,
        params: { ...params },
      })
    } else if (routed.route === "prompt") {
      this.elicitations.store({ ...pending, serverName, ...routed.prompt })
    } else {
      this.respondServerResult(request.id, { action: "decline" })
      this.reportError(
        threadId,
        `Declined a request from MCP server "${serverName}": ${routed.reason}.`,
      )
    }
  }

  private rejectInvalidParams(request: ServerRequest): void {
    this.respondServerError(
      request.id,
      -32602,
      `Invalid params for Codex server request ${request.method}`,
    )
  }

  private respondServerResult(requestId: JsonRpcId, result: JsonObject): void {
    this.writeServerResponse(requestId, { result })
  }

  private respondServerError(
    requestId: JsonRpcId,
    code: number,
    message: string,
  ): void {
    this.writeServerResponse(requestId, { error: { code, message } })
  }

  private writeServerResponse(requestId: JsonRpcId, payload: JsonObject): void {
    const child = this.child
    if (!child) return
    void this.writeMessage(child, { id: requestId, ...payload }).catch(
      (error: unknown) => {
        const connectionError = new CodexAppServerError(
          "Failed to respond to Codex server request",
          { cause: error },
        )
        this.disconnect(connectionError, child, true)
      },
    )
  }

  private handleNotification(notification: CodexNotification): void {
    const params = isRecord(notification.params) ? notification.params : null
    if (params) {
      const threadId = stringField(params, "threadId")
      if (notification.method === "thread/started") {
        const thread = params.thread
        if (isRecord(thread)) {
          const id = stringField(thread, "id")
          if (id) {
            this.rememberThread({
              ...thread,
              id,
              parentThreadId:
                stringField(thread, "parentThreadId") ?? null,
            })
          }
        }
      } else if (notification.method === "turn/started" && threadId) {
        const turn = params.turn
        if (isRecord(turn)) {
          const turnId = stringField(turn, "id")
          if (turnId) this.activeTurnIds.set(threadId, turnId)
        }
      } else if (notification.method === "turn/completed" && threadId) {
        const turn = params.turn
        const turnId = isRecord(turn) ? stringField(turn, "id") : undefined
        if (!turnId || this.activeTurnIds.get(threadId) === turnId) {
          this.activeTurnIds.delete(threadId)
        }
        if (turnId) {
          const key = JSON.stringify([threadId, turnId])
          const error = isRecord(turn) && isRecord(turn.error) ? stringField(turn.error, "message") : undefined
          const result = { isError: isRecord(turn) && ["failed", "interrupted"].includes(String(turn.status)), ...(error ? { message: error } : {}) }
          this.completedTurns.set(key, result)
          while (this.completedTurns.size > 256) this.completedTurns.delete(this.completedTurns.keys().next().value!)
          for (const waiter of this.completionWaiters.get(key) ?? []) waiter.resolve(result)
          this.completionWaiters.delete(key)
          this.approvals.removeForTurn(threadId, turnId)
          this.elicitations.removeForTurn(threadId, turnId)
        }
      } else if (notification.method === "thread/closed" && threadId) {
        this.activeTurnIds.delete(threadId)
        this.approvals.clearThread(threadId)
        this.elicitations.clearThread(threadId)
      } else if (notification.method === "serverRequest/resolved") {
        const requestId = params.requestId
        if (isRpcId(requestId)) {
          this.approvals.remove(requestId)
          this.elicitations.remove(requestId)
        }
      }
    }

    for (const listener of this.notificationListeners) {
      try {
        listener(notification)
      } catch {
        // Consumer failures must not break the protocol reader.
      }
    }
  }

  private request<T>(
    child: CodexAppServerProcess,
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (this.child !== child) {
      return Promise.reject(
        new CodexAppServerError("Codex app-server is not connected"),
      )
    }
    const id = this.nextRequestId++
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? this.setTimer(() => {
              const pending = this.pendingRequests.get(id)
              if (!pending) return
              this.pendingRequests.delete(id)
              pending.reject(
                new CodexAppServerError(
                  `Codex app-server ${method} timed out after ${timeoutMs}ms`,
                ),
              )
            }, timeoutMs)
          : null
      this.pendingRequests.set(id, {
        method,
        resolve: (result) => resolve(result as T),
        reject,
        timer,
      })
      const message: JsonObject = { method, id }
      if (params !== undefined) message.params = params
      void this.writeMessage(child, message).catch((error: unknown) => {
        const pending = this.pendingRequests.get(id)
        if (!pending) return
        this.pendingRequests.delete(id)
        if (pending.timer) this.clearTimer(pending.timer)
        const connectionError = new CodexAppServerError(
          `Failed to write Codex app-server request ${method}`,
          { cause: error },
        )
        pending.reject(connectionError)
        this.disconnect(connectionError, child, true)
      })
    })
  }

  private writeMessage(
    child: CodexAppServerProcess,
    message: JsonObject,
  ): Promise<void> {
    if (
      this.child !== child ||
      child.stdin.destroyed ||
      child.stdin.writableEnded
    ) {
      return Promise.reject(
        new CodexAppServerError("Codex app-server stdin is not writable"),
      )
    }
    return new Promise<void>((resolve, reject) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) reject(error)
          else resolve()
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  private rememberThread(thread: CodexThread): void {
    const parentThreadId = thread.parentThreadId
    if (!parentThreadId || parentThreadId === thread.id) return
    this.parentThreadIds.set(thread.id, parentThreadId)
  }

  private threadLineage(threadId: string): string[] {
    const lineage = [threadId]
    const seen = new Set(lineage)
    let current = threadId
    while (true) {
      const parent = this.parentThreadIds.get(current)
      if (!parent || seen.has(parent)) break
      lineage.push(parent)
      seen.add(parent)
      current = parent
    }
    return lineage
  }

  private isThreadOrDescendant(
    candidateThreadId: string,
    ancestorThreadId: string,
  ): boolean {
    return this.threadLineage(candidateThreadId).includes(ancestorThreadId)
  }

  private disconnect(
    error: Error,
    child: CodexAppServerProcess,
    kill: boolean,
  ): void {
    if (this.child !== child) return
    this.child = null
    this.initializeResult = null
    this.runningVersion = null
    this.startPromise = null
    this.reader?.close()
    this.reader = null
    this.rejectPending(error)
    this.clearRuntimeState()
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
    if (kill && !child.killed) {
      try {
        child.kill("SIGTERM")
      } catch {
        // The child may already have exited between the state check and kill.
      }
    }
  }

  private waitForChildClose(
    closed: Promise<void>,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (didClose: boolean) => {
        if (settled) return
        settled = true
        this.clearTimer(timer)
        resolve(didClose)
      }
      const timer = this.setTimer(() => finish(false), timeoutMs)
      void closed.then(() => finish(true))
    })
  }

  private async terminateChild(
    child: CodexAppServerProcess,
    error: Error,
  ): Promise<void> {
    let didClose = false
    let resolveClose: () => void = () => undefined
    const closed = new Promise<void>((resolve) => {
      resolveClose = resolve
    })
    child.on("close", () => {
      didClose = true
      resolveClose()
    })

    this.disconnect(error, child, true)
    if (await this.waitForChildClose(closed, SHUTDOWN_GRACE_MS)) return

    if (!didClose) {
      try {
        child.kill("SIGKILL")
      } catch {
        // The child may have exited between the timeout and force signal.
      }
    }
    await this.waitForChildClose(closed, FORCE_KILL_GRACE_MS)
  }

  private rejectPending(error: Error): void {
    for (const waiting of this.completionWaiters.values()) for (const waiter of waiting) waiter.reject(error)
    this.completionWaiters.clear()
    const pending = [...this.pendingRequests.values()]
    this.pendingRequests.clear()
    for (const request of pending) {
      if (request.timer) this.clearTimer(request.timer)
      request.reject(error)
    }
  }

  private clearRuntimeState(): void {
    this.activeTurnIds.clear()
    this.approvals.clear()
    this.elicitations.clear()
    this.parentThreadIds.clear()
  }
}

/** Shared process-backed client used by the HTTP runtime and approval routes. */
export const codexAppServer = new CodexAppServer({ reportError: publishError })
codexAppServer.subscribe(forwardCodexStreamNotification)
codexAppServer.subscribe((notification) => codexQuestions.observe(notification))
