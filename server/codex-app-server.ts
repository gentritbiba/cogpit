import { spawn as spawnChild } from "node:child_process"
import type { SpawnOptionsWithoutStdio } from "node:child_process"
import { createInterface } from "node:readline"
import type { Interface as ReadlineInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import packageJson from "../package.json"

export type JsonRpcId = string | number
export type JsonObject = Record<string, unknown>

export interface CodexAppServerProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  killed?: boolean
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: "error", listener: (error: Error) => void): this
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this
}

export type CodexAppServerSpawn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => CodexAppServerProcess

export interface CodexAppServerOptions {
  spawn?: CodexAppServerSpawn
  command?: string
  requestTimeoutMs?: number
  clientVersion?: string
  now?: () => number
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

export interface CodexNotification<T = unknown> {
  method: string
  params: T
}

export type CodexNotificationListener = (
  notification: CodexNotification,
) => void

export type PendingApprovalKind = "commandExecution" | "fileChange"
export type ApprovalDecision = "allow" | "allow_always" | "deny"

export interface PendingApproval {
  requestId: JsonRpcId
  kind: PendingApprovalKind
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
  threadId: string
  turnId: string
  itemId: string
  requestedAt: number
  reason?: string
  command?: string
  cwd?: string
  grantRoot?: string
  approvalId?: string
  networkApprovalContext?: unknown
  /** UI-level decisions that are valid for this specific server request. */
  availableDecisions: ApprovalDecision[]
  params: JsonObject
}

export type ApprovalListener = (
  threadId: string,
  approvals: readonly PendingApproval[],
) => void

export interface CodexThread extends JsonObject {
  id: string
  parentThreadId?: string | null
}

export interface CodexTurn extends JsonObject {
  id: string
  status?: string
}

export type ThreadStartParams = JsonObject

export interface ThreadResumeParams extends JsonObject {
  threadId: string
}

export interface UserInput extends JsonObject {
  type: string
}

export interface TurnStartParams extends JsonObject {
  threadId: string
  input: UserInput[]
}

export interface TurnSteerParams extends JsonObject {
  threadId: string
  input: UserInput[]
  expectedTurnId?: string
}

export interface ThreadGoal extends JsonObject {
  threadId: string
  objective: string
  status: string
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
}

export interface ThreadGoalSetParams extends JsonObject {
  threadId: string
  objective?: string | null
  status?: string | null
  tokenBudget?: number | null
}

export type InitializeResult = JsonObject
export interface ThreadResponse extends JsonObject {
  thread: CodexThread
}
export interface TurnResponse extends JsonObject {
  turn: CodexTurn
}
export interface TurnSteerResponse extends JsonObject {
  turnId: string
}
export interface ThreadGoalResponse extends JsonObject {
  goal: ThreadGoal | null
}
export interface ThreadGoalClearResponse extends JsonObject {
  cleared: boolean
}

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

const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval"
const FILE_APPROVAL_METHOD = "item/fileChange/requestApproval"
const CURRENT_TIME_METHOD = "currentTime/read"
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_STDERR_LENGTH = 16_000

/**
 * Capabilities Cogpit actually implements on the app-server connection.
 *
 * Experimental API opt-in is deliberately off: it is a broad protocol switch,
 * not a declaration for the individual experimental methods Cogpit supports.
 * Stable client requests such as goals remain available without it.
 */
export const CODEX_CLIENT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
} as const

const defaultSpawn: CodexAppServerSpawn = (command, args, options) =>
  spawnChild(command, args, options)

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number"
}

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key]
  return typeof value === "string" ? value : undefined
}

function approvalKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`
}

const DEFAULT_APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  "allow",
  "allow_always",
  "deny",
]

/**
 * Translate the protocol's richer decision union into the three decisions the
 * shared Cogpit approval UI can express. Amendment-bearing decisions remain
 * unavailable until Cogpit has a dedicated UI for reviewing their payloads.
 */
function normalizeAvailableDecisions(value: unknown): ApprovalDecision[] {
  if (value == null) return [...DEFAULT_APPROVAL_DECISIONS]
  if (!Array.isArray(value)) return []

  const decisions: ApprovalDecision[] = []
  const add = (decision: ApprovalDecision) => {
    if (!decisions.includes(decision)) decisions.push(decision)
  }
  for (const decision of value) {
    if (decision === "accept") add("allow")
    else if (decision === "acceptForSession") add("allow_always")
    else if (decision === "decline" || decision === "cancel") add("deny")
  }
  return decisions
}

function wireApprovalDecision(
  approval: PendingApproval,
  decision: ApprovalDecision,
): unknown {
  const available = approval.params.availableDecisions
  if (!Array.isArray(available)) {
    return {
      allow: "accept",
      allow_always: "acceptForSession",
      deny: "decline",
    }[decision]
  }

  if (decision === "allow") {
    return available.find((candidate) => candidate === "accept")
  }
  if (decision === "allow_always") {
    return available.find((candidate) => candidate === "acceptForSession")
  }
  return available.find(
    (candidate) => candidate === "decline" || candidate === "cancel",
  )
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
 * requests are rejected and the next call starts a fresh connection.
 */
export class CodexAppServer {
  private readonly spawn: CodexAppServerSpawn
  private readonly command: string
  private readonly requestTimeoutMs: number
  private readonly clientVersion: string
  private readonly now: () => number
  private readonly setTimer: typeof globalThis.setTimeout
  private readonly clearTimer: typeof globalThis.clearTimeout

  private child: CodexAppServerProcess | null = null
  private reader: ReadlineInterface | null = null
  private startPromise: Promise<InitializeResult> | null = null
  private initializeResult: InitializeResult | null = null
  private shuttingDown = false
  private nextRequestId = 1
  private stderr = ""

  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>()
  private readonly notificationListeners = new Set<CodexNotificationListener>()
  private readonly approvalListeners = new Set<ApprovalListener>()
  private readonly activeTurnIds = new Map<string, string>()
  private readonly parentThreadIds = new Map<string, string>()
  private readonly approvalsByThread = new Map<
    string,
    Map<string, PendingApproval>
  >()
  private readonly approvalsByRequest = new Map<string, PendingApproval>()

  constructor(options: CodexAppServerOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn
    this.command = options.command ?? "codex"
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.clientVersion = options.clientVersion ?? packageJson.version
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimeout ?? globalThis.setTimeout
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout
  }

  start(): Promise<InitializeResult> {
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
      child = this.spawn(this.command, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
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
      this.disconnect(
        new CodexAppServerError("Codex app-server connection restarted"),
        child,
        true,
      )
    }
    return this.start()
  }

  call<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
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

  listPendingApprovals(threadId: string): PendingApproval[] {
    const approvals = [...this.approvalsByThread.entries()]
      .filter(([approvalThreadId]) =>
        this.isThreadOrDescendant(approvalThreadId, threadId),
      )
      .flatMap(([, threadApprovals]) => [...threadApprovals.values()])
    return approvals
      .sort((left, right) => left.requestedAt - right.requestedAt)
      .map((approval) => ({
        ...approval,
        availableDecisions: [...approval.availableDecisions],
        params: { ...approval.params },
      }))
  }

  async respondApproval(
    requestOrApproval: JsonRpcId | PendingApproval,
    decision: ApprovalDecision,
  ): Promise<void> {
    const requestId =
      typeof requestOrApproval === "object"
        ? requestOrApproval.requestId
        : requestOrApproval
    const approval = this.approvalsByRequest.get(approvalKey(requestId))
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
    const child = this.child
    if (!child || !this.initializeResult) {
      throw new CodexAppServerError("Codex app-server is not connected")
    }
    const wireDecision = wireApprovalDecision(approval, decision)
    if (wireDecision === undefined) {
      throw new CodexAppServerError(
        `Decision ${decision} cannot be represented for approval request ${String(requestId)}`,
      )
    }
    try {
      await this.writeMessage(child, {
        id: requestId,
        result: { decision: wireDecision },
      })
    } catch (error) {
      const connectionError = new CodexAppServerError(
        "Failed to respond to Codex approval request",
        { cause: error },
      )
      this.disconnect(connectionError, child, true)
      throw connectionError
    }
    this.removeApproval(requestId)
  }

  subscribe(listener: CodexNotificationListener): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onNotification(listener: CodexNotificationListener): () => void {
    return this.subscribe(listener)
  }

  subscribeApprovals(listener: ApprovalListener): () => void {
    this.approvalListeners.add(listener)
    return () => this.approvalListeners.delete(listener)
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    const child = this.child
    if (child) {
      this.disconnect(
        new CodexAppServerError("Codex app-server client shut down"),
        child,
        true,
      )
    } else {
      this.rejectPending(
        new CodexAppServerError("Codex app-server client shut down"),
      )
      this.clearRuntimeState()
    }
    this.notificationListeners.clear()
    this.approvalListeners.clear()
  }

  private async initialize(
    child: CodexAppServerProcess,
  ): Promise<InitializeResult> {
    try {
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
    if (!isObject(message)) return
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
      if (!isObject(request.params) || !stringField(request.params, "threadId")) {
        this.respondServerError(
          request.id,
          -32602,
          `Invalid params for Codex server request ${request.method}`,
        )
        return
      }
      this.respondServerResult(request.id, {
        currentTimeAt: Math.floor(this.now() / 1000),
      })
      return
    }

    if (
      request.method !== COMMAND_APPROVAL_METHOD &&
      request.method !== FILE_APPROVAL_METHOD
    ) {
      this.respondServerError(
        request.id,
        -32601,
        `Unsupported Codex server request: ${request.method}`,
      )
      return
    }
    if (!isObject(request.params)) {
      this.respondServerError(
        request.id,
        -32602,
        `Invalid params for Codex server request ${request.method}`,
      )
      return
    }
    const threadId = stringField(request.params, "threadId")
    const turnId = stringField(request.params, "turnId")
    const itemId = stringField(request.params, "itemId")
    if (!threadId || !turnId || !itemId) {
      this.respondServerError(
        request.id,
        -32602,
        `Invalid params for Codex server request ${request.method}`,
      )
      return
    }

    const requestedAtValue = request.params.startedAtMs
    const approval: PendingApproval = {
      requestId: request.id,
      kind:
        request.method === COMMAND_APPROVAL_METHOD
          ? "commandExecution"
          : "fileChange",
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
    }
    this.storeApproval(approval)
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
    const params = isObject(notification.params) ? notification.params : null
    if (params) {
      const threadId = stringField(params, "threadId")
      if (notification.method === "thread/started") {
        const thread = params.thread
        if (isObject(thread)) {
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
        if (isObject(turn)) {
          const turnId = stringField(turn, "id")
          if (turnId) this.activeTurnIds.set(threadId, turnId)
        }
      } else if (notification.method === "turn/completed" && threadId) {
        const turn = params.turn
        const turnId = isObject(turn) ? stringField(turn, "id") : undefined
        if (!turnId || this.activeTurnIds.get(threadId) === turnId) {
          this.activeTurnIds.delete(threadId)
        }
        if (turnId) this.removeApprovalsForTurn(threadId, turnId)
      } else if (notification.method === "thread/closed" && threadId) {
        this.activeTurnIds.delete(threadId)
        this.clearApprovalsForThread(threadId)
      } else if (notification.method === "serverRequest/resolved") {
        const requestId = params.requestId
        if (isRpcId(requestId)) this.removeApproval(requestId)
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

  private storeApproval(approval: PendingApproval): void {
    const key = approvalKey(approval.requestId)
    const previous = this.approvalsByRequest.get(key)
    if (previous) this.removeApproval(previous.requestId)
    let threadApprovals = this.approvalsByThread.get(approval.threadId)
    if (!threadApprovals) {
      threadApprovals = new Map()
      this.approvalsByThread.set(approval.threadId, threadApprovals)
    }
    threadApprovals.set(key, approval)
    this.approvalsByRequest.set(key, approval)
    this.emitApprovalChanges(approval.threadId)
  }

  private removeApproval(requestId: JsonRpcId): void {
    const key = approvalKey(requestId)
    const approval = this.approvalsByRequest.get(key)
    if (!approval) return
    this.approvalsByRequest.delete(key)
    const threadApprovals = this.approvalsByThread.get(approval.threadId)
    threadApprovals?.delete(key)
    if (threadApprovals?.size === 0) {
      this.approvalsByThread.delete(approval.threadId)
    }
    this.emitApprovalChanges(approval.threadId)
  }

  private removeApprovalsForTurn(threadId: string, turnId: string): void {
    const approvals = this.approvalsByThread.get(threadId)
    if (!approvals) return
    const requestIds = [...approvals.values()]
      .filter((approval) => approval.turnId === turnId)
      .map((approval) => approval.requestId)
    for (const requestId of requestIds) this.removeApproval(requestId)
  }

  private clearApprovalsForThread(threadId: string): void {
    const approvals = this.approvalsByThread.get(threadId)
    if (!approvals) return
    for (const approval of approvals.values()) {
      this.approvalsByRequest.delete(approvalKey(approval.requestId))
    }
    this.approvalsByThread.delete(threadId)
    this.emitApprovalChanges(threadId)
  }

  private rememberThread(thread: CodexThread): void {
    const parentThreadId = thread.parentThreadId
    if (!parentThreadId || parentThreadId === thread.id) return
    this.parentThreadIds.set(thread.id, parentThreadId)
    if (this.approvalsByThread.has(thread.id)) {
      this.emitApprovalChanges(thread.id)
    }
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

  private emitApprovalChanges(threadId: string): void {
    for (const audienceThreadId of this.threadLineage(threadId)) {
      const approvals = this.listPendingApprovals(audienceThreadId)
      for (const listener of this.approvalListeners) {
        try {
          listener(audienceThreadId, approvals)
        } catch {
          // Consumer failures must not break the protocol reader.
        }
      }
    }
  }

  private disconnect(
    error: Error,
    child: CodexAppServerProcess,
    kill: boolean,
  ): void {
    if (this.child !== child) return
    this.child = null
    this.initializeResult = null
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

  private rejectPending(error: Error): void {
    const pending = [...this.pendingRequests.values()]
    this.pendingRequests.clear()
    for (const request of pending) {
      if (request.timer) this.clearTimer(request.timer)
      request.reject(error)
    }
  }

  private clearRuntimeState(): void {
    const threadIds = new Set(
      [...this.approvalsByThread.keys()].flatMap((threadId) =>
        this.threadLineage(threadId),
      ),
    )
    this.activeTurnIds.clear()
    this.approvalsByRequest.clear()
    this.approvalsByThread.clear()
    for (const threadId of threadIds) {
      for (const listener of this.approvalListeners) {
        try {
          listener(threadId, [])
        } catch {
          // Consumer failures must not break disconnect cleanup.
        }
      }
    }
    this.parentThreadIds.clear()
  }
}

/** Shared process-backed client used by the HTTP runtime and approval routes. */
export const codexAppServer = new CodexAppServer()
