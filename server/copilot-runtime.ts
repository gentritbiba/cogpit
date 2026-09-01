import { spawn as spawnChild } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { Readable, Writable } from "node:stream"
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type Message,
  type MessageConnection,
} from "vscode-jsonrpc/node.js"
import { findExecutableOnPath, resolveAgentCommand } from "./lib/binaryResolver"

export type CopilotJsonObject = Record<string, unknown>

export interface CopilotRuntimeProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly killed: boolean
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: "error", listener: (error: Error) => void): this
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this
}

export interface CopilotRuntimeSpawnOptions {
  cwd?: string
  env: NodeJS.ProcessEnv
  stdio: ["pipe", "pipe", "pipe"]
  windowsVerbatimArguments?: boolean
}

export type CopilotRuntimeSpawn = (
  command: string,
  args: string[],
  options: CopilotRuntimeSpawnOptions,
) => CopilotRuntimeProcess

export interface CopilotRuntimeOptions {
  command?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Bounds transport startup, shutdown, and emergency cancellation. */
  transportTimeoutMs?: number
  /** Bounds ordinary control RPCs so a live but wedged CLI cannot hang an HTTP request forever. */
  requestTimeoutMs?: number
  spawn?: CopilotRuntimeSpawn
}

export interface CopilotModel extends CopilotJsonObject {
  id: string
  name?: string
}

export interface CopilotAccountQuotaSnapshot {
  isUnlimitedEntitlement?: boolean
  entitlementRequests?: number
  usedRequests?: number
  usageAllowedWithExhaustedQuota?: boolean
  remainingPercentage?: number
  overage?: number
  overageAllowedWithExhaustedQuota?: boolean
  resetDate?: string | null
  hasQuota?: boolean
  tokenBasedBilling?: boolean
}

export interface CopilotAccountQuota {
  quotaSnapshots: Record<string, CopilotAccountQuotaSnapshot>
}

export interface CopilotSessionModelTokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface CopilotSessionModelUsage {
  totalNanoAiu?: number
  usage?: CopilotSessionModelTokenUsage
}

export interface CopilotSessionUsage {
  totalNanoAiu?: number
  totalPremiumRequestCost?: number
  modelMetrics?: Record<string, CopilotSessionModelUsage>
}

export interface CopilotSessionOptions extends CopilotJsonObject {
  sessionId?: string
  workingDirectory?: string
  model?: string
  reasoningEffort?: string
  streaming?: boolean
}

export interface CopilotResumeOptions extends CopilotSessionOptions {
  disableResume?: boolean
  continuePendingWork?: boolean
}

export interface CopilotSessionOpenResult extends CopilotJsonObject {
  sessionId: string
  workspacePath?: string
  capabilities?: CopilotJsonObject
}

export interface CopilotSendOptions extends CopilotJsonObject {
  prompt: string
  displayPrompt?: string
  attachments?: unknown[]
  mode?: string
  agentMode?: string
  requestHeaders?: Record<string, string>
}

export interface CopilotSessionEvent extends CopilotJsonObject {
  type: string
  id?: string
  parentId?: string | null
  timestamp?: string
  agentId?: string
  ephemeral?: boolean
  data?: unknown
}

export interface CopilotSessionEventNotification {
  sessionId: string
  event: CopilotSessionEvent
}

export interface CopilotPendingPermission {
  sessionId: string
  requestId: string
  request: unknown
  rawRequest?: unknown
  requestedAt: number
}

export interface CopilotPermissionDecision extends CopilotJsonObject {
  kind: string
}

export interface CopilotPendingUserInput {
  sessionId: string
  requestId: string
  question: string
  choices?: string[]
  allowFreeform?: boolean
  askedAt: number
}

export interface CopilotUserInputAnswer {
  answer: string
  wasFreeform: boolean
}

export interface CopilotModelSwitchResult {
  modelId?: string
  deferred?: boolean
}

export interface CopilotReasoningEffortResult {
  reasoningEffort: string
}

export interface CopilotDeleteSessionResult {
  success: boolean
  error?: string
}

export interface CopilotForkSessionResult {
  sessionId: string
  name?: string
}

export type CopilotRewindMode = "conversation" | "conversation-and-files"

export interface CopilotRewindPoint extends CopilotJsonObject {
  eventId: string
  userMessage: string
  timestamp: string
  canRestoreFiles: boolean
  fileCount: number
  turnChangedFiles: boolean
  linesAdded: number
  linesRemoved: number
  isAutopilotContinuation: boolean
}

export interface CopilotRewindPointsResult extends CopilotJsonObject {
  fileChangeTrackingEnabled: boolean
  unavailableReason?: string
  points: CopilotRewindPoint[]
}

export interface CopilotRewindFilePreview extends CopilotJsonObject {
  path: string
  changeType: "created" | "deleted" | "modified"
  linesAdded: number
  linesRemoved: number
}

export interface CopilotRewindPreviewResult extends CopilotJsonObject {
  available: boolean
  reason?: string
  fileCount: number
  files: CopilotRewindFilePreview[]
}

export interface CopilotRewindResult extends CopilotJsonObject {
  outcome: string
  eventsRemoved?: number
  restoredFiles: string[]
  skippedFiles: Array<CopilotJsonObject & { path: string; reason: string }>
  error?: string
}

export interface CopilotPendingExitPlan {
  sessionId: string
  requestId: string
  summary: string
  planContent?: string
  actions: string[]
  recommendedAction: string
  askedAt: number
}

export interface CopilotExitPlanResponse {
  approved: boolean
  selectedAction?: string
  feedback?: string
}

interface InternalPendingUserInput {
  value: CopilotPendingUserInput
  resolve: (answer: CopilotUserInputAnswer) => void
  reject: (error: Error) => void
}

interface InternalPendingExitPlan {
  value: CopilotPendingExitPlan
  resolve: (answer: CopilotExitPlanResponse) => void
  reject: (error: Error) => void
}

const PROTOCOL_VERSION = 3
const DEFAULT_TRANSPORT_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const MAX_STDERR_TAIL = 16 * 1024
const COPILOT_ARGS = ["--headless", "--no-auto-update", "--stdio"]
const MUTATING_RPC_METHODS = new Set([
  "session.abort",
  "session.create",
  "session.delete",
  "session.destroy",
  "session.history.rewind",
  "session.model.setReasoningEffort",
  "session.model.switchTo",
  "session.name.set",
  "session.permissions.handlePendingPermissionRequest",
  "session.permissions.setAllowAll",
  "session.permissions.setMode",
  "session.resume",
  "session.send",
  "sessions.fork",
])

const SESSION_DEFAULTS: CopilotJsonObject = {
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
}

const defaultSpawn: CopilotRuntimeSpawn = (command, args, options) =>
  spawnChild(command, args, options) as CopilotRuntimeProcess

class TeardownResilientStreamMessageWriter extends StreamMessageWriter {
  suppressWriteErrors = false

  override async write(message: Message): Promise<void> {
    try {
      await super.write(message)
    } catch (error) {
      if (!this.suppressWriteErrors) throw error
    }
  }
}

function isObject(value: unknown): value is CopilotJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isMethodNotFound(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 3 && isObject(current); depth++) {
    if (current.code === -32601) return true
    current = current.cause
  }
  return false
}

function requiredString(
  value: CopilotJsonObject,
  key: string,
  method: string,
): string {
  const field = value[key]
  if (typeof field !== "string" || field.length === 0) {
    throw new CopilotRuntimeError(`Copilot CLI ${method} returned no ${key}`)
  }
  return field
}

export class CopilotRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CopilotRuntimeError"
  }
}

class CopilotRequestTimeoutError extends CopilotRuntimeError {
  constructor(readonly method: string) {
    super(`Copilot CLI ${method} timed out`)
  }
}

export class CopilotRuntime {
  private readonly command: string
  private readonly cwd: string | undefined
  private readonly env: NodeJS.ProcessEnv
  private readonly transportTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly spawn: CopilotRuntimeSpawn

  private child: CopilotRuntimeProcess | null = null
  private connection: MessageConnection | null = null
  private messageWriter: TeardownResilientStreamMessageWriter | null = null
  private startPromise: Promise<void> | null = null
  private shutdownPromise: Promise<Error[]> | null = null
  private stopped = false
  private permissionModeRpc: "unknown" | "stable" | "current" = "unknown"

  private readonly activeSessions = new Set<string>()
  private readonly activeTurns = new Set<string>()
  private readonly sendingSessions = new Set<string>()
  private readonly openingSessions = new Set<string>()
  private readonly conflictingResumes = new Set<string>()
  private readonly pendingPermissions = new Map<string, Map<string, CopilotPendingPermission>>()
  private readonly pendingUserInputs = new Map<string, InternalPendingUserInput>()
  private readonly pendingExitPlans = new Map<string, InternalPendingExitPlan>()
  constructor(options: CopilotRuntimeOptions = {}) {
    this.command = options.command ?? "copilot"
    this.cwd = options.cwd
    this.env = options.env ?? process.env
    this.transportTimeoutMs = options.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.spawn = options.spawn ?? defaultSpawn
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId)
  }

  isTurnActive(sessionId: string): boolean {
    return this.activeTurns.has(sessionId)
  }

  getActiveSessionIds(): string[] {
    return [...this.activeSessions]
  }

  getPendingPermissions(sessionId?: string): CopilotPendingPermission[] {
    if (sessionId !== undefined) {
      return [...(this.pendingPermissions.get(sessionId)?.values() ?? [])]
    }
    return [...this.pendingPermissions.values()].flatMap((requests) => [...requests.values()])
  }

  getPendingUserInputs(sessionId?: string): CopilotPendingUserInput[] {
    const inputs = [...this.pendingUserInputs.values()].map(({ value }) => value)
    return sessionId === undefined
      ? inputs
      : inputs.filter((input) => input.sessionId === sessionId)
  }

  getPendingExitPlans(sessionId?: string): CopilotPendingExitPlan[] {
    const plans = [...this.pendingExitPlans.values()].map(({ value }) => value)
    return sessionId === undefined
      ? plans
      : plans.filter((plan) => plan.sessionId === sessionId)
  }

  async listModels(): Promise<CopilotModel[]> {
    const response = await this.request<unknown>("models.list", {})
    if (!isObject(response) || !Array.isArray(response.models)) {
      throw new CopilotRuntimeError("Copilot CLI models.list returned no models")
    }
    return response.models.filter(isObject) as CopilotModel[]
  }

  async getAccountQuota(): Promise<CopilotAccountQuota> {
    const response = await this.request<unknown>("account.getQuota", {})
    if (!isObject(response) || !isObject(response.quotaSnapshots)) {
      throw new CopilotRuntimeError(
        "Copilot CLI account.getQuota returned no quota snapshots",
      )
    }

    const quotaSnapshots: Record<string, CopilotAccountQuotaSnapshot> = {}
    for (const [name, value] of Object.entries(response.quotaSnapshots)) {
      if (!isObject(value)) continue
      const snapshot: CopilotAccountQuotaSnapshot = {}
      if (typeof value.isUnlimitedEntitlement === "boolean") {
        snapshot.isUnlimitedEntitlement = value.isUnlimitedEntitlement
      }
      if (typeof value.entitlementRequests === "number") {
        snapshot.entitlementRequests = value.entitlementRequests
      }
      if (typeof value.usedRequests === "number") {
        snapshot.usedRequests = value.usedRequests
      }
      if (typeof value.usageAllowedWithExhaustedQuota === "boolean") {
        snapshot.usageAllowedWithExhaustedQuota = value.usageAllowedWithExhaustedQuota
      }
      if (typeof value.remainingPercentage === "number") {
        snapshot.remainingPercentage = value.remainingPercentage
      }
      if (typeof value.overage === "number") snapshot.overage = value.overage
      if (typeof value.overageAllowedWithExhaustedQuota === "boolean") {
        snapshot.overageAllowedWithExhaustedQuota = value.overageAllowedWithExhaustedQuota
      }
      if (typeof value.resetDate === "string" || value.resetDate === null) {
        snapshot.resetDate = value.resetDate
      }
      if (typeof value.hasQuota === "boolean") snapshot.hasQuota = value.hasQuota
      if (typeof value.tokenBasedBilling === "boolean") {
        snapshot.tokenBasedBilling = value.tokenBasedBilling
      }
      quotaSnapshots[name] = snapshot
    }
    return { quotaSnapshots }
  }

  async getSessionUsage(sessionId: string): Promise<CopilotSessionUsage> {
    this.assertSessionActive(sessionId)
    const response = await this.request<unknown>("session.usage.getMetrics", { sessionId })
    if (!isObject(response)) {
      throw new CopilotRuntimeError(
        "Copilot CLI session.usage.getMetrics returned an invalid response",
      )
    }
    const usage: CopilotSessionUsage = {}
    if (typeof response.totalNanoAiu === "number") {
      usage.totalNanoAiu = response.totalNanoAiu
    }
    if (typeof response.totalPremiumRequestCost === "number") {
      usage.totalPremiumRequestCost = response.totalPremiumRequestCost
    }
    if (isObject(response.modelMetrics)) {
      usage.modelMetrics = Object.fromEntries(
        Object.entries(response.modelMetrics).flatMap(([model, value]) => {
          if (!isObject(value)) return []
          const metric: CopilotSessionModelUsage = {}
          if (typeof value.totalNanoAiu === "number") {
            metric.totalNanoAiu = value.totalNanoAiu
          }
          if (isObject(value.usage)) {
            const tokenUsage: CopilotSessionModelTokenUsage = {}
            for (const key of [
              "inputTokens",
              "outputTokens",
              "cacheReadTokens",
              "cacheWriteTokens",
              "reasoningTokens",
            ] as const) {
              if (typeof value.usage[key] === "number") {
                tokenUsage[key] = value.usage[key]
              }
            }
            metric.usage = tokenUsage
          }
          return [[model, metric]]
        }),
      )
    }
    return usage
  }

  async createSession(options: CopilotSessionOptions = {}): Promise<CopilotSessionOpenResult> {
    const sessionId = options.sessionId ?? randomUUID()
    this.assertSessionAvailable(sessionId)
    this.openingSessions.add(sessionId)
    try {
      const response = await this.request<unknown>("session.create", {
        ...SESSION_DEFAULTS,
        ...options,
        sessionId,
      })
      const result = this.parseSessionOpenResult("session.create", response)
      if (result.sessionId !== sessionId) {
        throw new CopilotRuntimeError(
          `Copilot CLI session.create returned ${result.sessionId} for requested session ${sessionId}`,
        )
      }
      this.activeSessions.add(sessionId)
      return result
    } finally {
      this.openingSessions.delete(sessionId)
    }
  }

  async resumeSession(
    sessionId: string,
    options: CopilotResumeOptions = {},
  ): Promise<CopilotSessionOpenResult> {
    this.assertSessionAvailable(sessionId)
    this.openingSessions.add(sessionId)
    this.conflictingResumes.delete(sessionId)
    try {
      const usage = await this.request<unknown>("sessions.checkInUse", {
        sessionIds: [sessionId],
      })
      if (!isObject(usage) || !Array.isArray(usage.inUse)) {
        throw new CopilotRuntimeError(
          "Copilot CLI sessions.checkInUse returned an invalid response",
        )
      }
      if (usage.inUse.includes(sessionId)) {
        throw new CopilotRuntimeError(
          `Copilot session ${sessionId} is already in use by another process`,
        )
      }

      const response = await this.request<unknown>("session.resume", {
        ...SESSION_DEFAULTS,
        ...options,
        sessionId,
      })
      const result = this.parseSessionOpenResult("session.resume", response)
      if (result.sessionId !== sessionId) {
        throw new CopilotRuntimeError(
          `Copilot CLI session.resume returned ${result.sessionId} for requested session ${sessionId}`,
        )
      }
      if (this.conflictingResumes.has(sessionId)) {
        await this.request("session.destroy", { sessionId }).catch(() => {})
        this.clearSessionState(sessionId, "Copilot session is already in use")
        throw new CopilotRuntimeError(
          `Copilot session ${sessionId} is already in use by another process`,
        )
      }
      this.activeSessions.add(sessionId)
      try {
        await this.refreshPendingPermissions(sessionId)
      } catch (error) {
        await this.request("session.destroy", { sessionId }).catch(() => {})
        this.clearSessionState(sessionId, "Failed to resume Copilot session")
        throw error
      }
      return result
    } finally {
      this.conflictingResumes.delete(sessionId)
      this.openingSessions.delete(sessionId)
    }
  }

  async send(
    sessionId: string,
    optionsOrPrompt: CopilotSendOptions | string,
  ): Promise<string> {
    this.assertSessionActive(sessionId)
    if (this.sendingSessions.has(sessionId)) {
      throw new CopilotRuntimeError(
        `Copilot session ${sessionId} is already accepting a message`,
      )
    }
    const options = typeof optionsOrPrompt === "string"
      ? { prompt: optionsOrPrompt }
      : optionsOrPrompt
    const turnWasActive = this.activeTurns.has(sessionId)
    this.sendingSessions.add(sessionId)
    this.activeTurns.add(sessionId)
    try {
      const response = await this.request<unknown>("session.send", {
        sessionId,
        ...options,
      })
      if (!isObject(response)) {
        throw new CopilotRuntimeError("Copilot CLI session.send returned an invalid response")
      }
      return requiredString(response, "messageId", "session.send")
    } catch (error) {
      if (error instanceof CopilotRequestTimeoutError) {
        await this.containTimedOutSend(sessionId, error)
      }
      if (!turnWasActive) this.activeTurns.delete(sessionId)
      throw error
    } finally {
      this.sendingSessions.delete(sessionId)
    }
  }

  async abort(sessionId: string): Promise<void> {
    this.assertSessionActive(sessionId)
    await this.request("session.abort", { sessionId })
    this.activeTurns.delete(sessionId)
    this.clearPendingInteractions(sessionId, "Copilot turn was aborted")
  }

  async destroySession(sessionId: string): Promise<void> {
    this.assertSessionActive(sessionId)
    await this.request("session.destroy", { sessionId })
    this.clearSessionState(sessionId, "Copilot session was destroyed")
  }

  async deleteSession(sessionId: string): Promise<CopilotDeleteSessionResult> {
    const response = await this.request<unknown>("session.delete", { sessionId })
    if (!isObject(response) || typeof response.success !== "boolean") {
      throw new CopilotRuntimeError("Copilot CLI session.delete returned an invalid response")
    }
    const result: CopilotDeleteSessionResult = {
      success: response.success,
      ...(typeof response.error === "string" ? { error: response.error } : {}),
    }
    if (!result.success) {
      throw new CopilotRuntimeError(
        `Failed to delete Copilot session ${sessionId}: ${result.error ?? "Unknown error"}`,
      )
    }
    this.clearSessionState(sessionId, "Copilot session was deleted")
    return result
  }

  async forkSession(
    sessionId: string,
    options: { toEventId?: string; name?: string } = {},
  ): Promise<CopilotForkSessionResult> {
    const response = await this.request<unknown>("sessions.fork", {
      sessionId,
      ...options,
    })
    if (!isObject(response)) {
      throw new CopilotRuntimeError("Copilot CLI sessions.fork returned an invalid response")
    }
    const forkedSessionId = requiredString(response, "sessionId", "sessions.fork")
    return {
      sessionId: forkedSessionId,
      ...(typeof response.name === "string" ? { name: response.name } : {}),
    }
  }

  async listRewindPoints(sessionId: string): Promise<CopilotRewindPointsResult> {
    this.assertSessionActive(sessionId)
    const response = await this.request<unknown>("session.history.listRewindPoints", {
      sessionId,
    })
    if (
      !isObject(response)
      || typeof response.fileChangeTrackingEnabled !== "boolean"
      || !Array.isArray(response.points)
    ) {
      throw new CopilotRuntimeError(
        "Copilot CLI session.history.listRewindPoints returned an invalid response",
      )
    }
    return response as unknown as CopilotRewindPointsResult
  }

  async previewRewind(
    sessionId: string,
    eventId: string,
  ): Promise<CopilotRewindPreviewResult> {
    this.assertSessionActive(sessionId)
    const response = await this.request<unknown>("session.history.previewRewind", {
      sessionId,
      eventId,
    })
    if (
      !isObject(response)
      || typeof response.available !== "boolean"
      || typeof response.fileCount !== "number"
      || !Array.isArray(response.files)
    ) {
      throw new CopilotRuntimeError(
        "Copilot CLI session.history.previewRewind returned an invalid response",
      )
    }
    return response as unknown as CopilotRewindPreviewResult
  }

  async rewind(
    sessionId: string,
    eventId: string,
    mode: CopilotRewindMode,
  ): Promise<CopilotRewindResult> {
    this.assertSessionActive(sessionId)
    const response = await this.request<unknown>("session.history.rewind", {
      sessionId,
      eventId,
      mode,
    })
    if (
      !isObject(response)
      || typeof response.outcome !== "string"
      || !Array.isArray(response.restoredFiles)
      || !Array.isArray(response.skippedFiles)
    ) {
      throw new CopilotRuntimeError(
        "Copilot CLI session.history.rewind returned an invalid response",
      )
    }
    return response as unknown as CopilotRewindResult
  }

  async setPermissionMode(sessionId: string, allowAll: boolean): Promise<void> {
    this.assertSessionActive(sessionId)
    let response: unknown
    if (this.permissionModeRpc === "current") {
      response = await this.request<unknown>("session.permissions.setMode", {
        sessionId,
        mode: allowAll ? "allow-all" : "manual",
        source: "rpc",
      })
    } else try {
      response = await this.request<unknown>("session.permissions.setAllowAll", {
        sessionId,
        mode: allowAll ? "on" : "off",
        source: "rpc",
      })
      this.permissionModeRpc = "stable"
    } catch (error) {
      if (!isMethodNotFound(error)) throw error
      this.permissionModeRpc = "current"
      response = await this.request<unknown>("session.permissions.setMode", {
        sessionId,
        mode: allowAll ? "allow-all" : "manual",
        source: "rpc",
      })
    }
    if (!isObject(response) || response.success !== true) {
      throw new CopilotRuntimeError("Copilot CLI failed to update its permission mode")
    }
  }

  async setModel(
    sessionId: string,
    modelId: string,
    reasoningEffort?: string,
  ): Promise<CopilotModelSwitchResult> {
    this.assertSessionActive(sessionId)
    const response = await this.request<unknown>("session.model.switchTo", {
      sessionId,
      modelId,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
    if (!isObject(response)) {
      throw new CopilotRuntimeError("Copilot CLI session.model.switchTo returned an invalid response")
    }
    return {
      ...(typeof response.modelId === "string" ? { modelId: response.modelId } : {}),
      ...(typeof response.deferred === "boolean" ? { deferred: response.deferred } : {}),
    }
  }

  async setReasoningEffort(
    sessionId: string,
    reasoningEffort: string,
  ): Promise<CopilotReasoningEffortResult> {
    this.assertSessionActive(sessionId)
    const response = await this.request<unknown>("session.model.setReasoningEffort", {
      sessionId,
      reasoningEffort,
    })
    if (!isObject(response) || typeof response.reasoningEffort !== "string") {
      throw new CopilotRuntimeError(
        "Copilot CLI session.model.setReasoningEffort returned an invalid response",
      )
    }
    return { reasoningEffort: response.reasoningEffort }
  }

  async setSessionName(sessionId: string, name: string): Promise<void> {
    this.assertSessionActive(sessionId)
    await this.request("session.name.set", { sessionId, name })
  }

  async refreshPendingPermissions(sessionId: string): Promise<CopilotPendingPermission[]> {
    this.assertSessionActive(sessionId)
    const response = await this.request<unknown>("session.permissions.pendingRequests", {
      sessionId,
    })
    if (!isObject(response) || !Array.isArray(response.items)) {
      throw new CopilotRuntimeError(
        "Copilot CLI session.permissions.pendingRequests returned an invalid response",
      )
    }

    const requests = new Map<string, CopilotPendingPermission>()
    for (const item of response.items) {
      if (!isObject(item) || typeof item.requestId !== "string") continue
      requests.set(item.requestId, {
        sessionId,
        requestId: item.requestId,
        request: item.request,
        requestedAt: Date.now(),
      })
    }
    if (requests.size === 0) this.pendingPermissions.delete(sessionId)
    else this.pendingPermissions.set(sessionId, requests)
    return [...requests.values()]
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    result: CopilotPermissionDecision,
  ): Promise<boolean> {
    this.assertSessionActive(sessionId)
    const response = await this.request<unknown>(
      "session.permissions.handlePendingPermissionRequest",
      { sessionId, requestId, result },
    )
    if (!isObject(response) || typeof response.success !== "boolean") {
      throw new CopilotRuntimeError("Copilot CLI returned an invalid permission response")
    }
    this.removePendingPermission(sessionId, requestId)
    return response.success
  }

  answerUserInput(
    sessionId: string,
    requestId: string,
    answer: CopilotUserInputAnswer,
  ): void {
    const key = this.pendingInteractionKey(sessionId, requestId)
    const pending = this.pendingUserInputs.get(key)
    if (!pending || pending.value.sessionId !== sessionId) {
      throw new CopilotRuntimeError(`No pending Copilot user input request ${requestId}`)
    }
    this.pendingUserInputs.delete(key)
    pending.resolve(answer)
  }

  answerExitPlan(
    sessionId: string,
    requestId: string,
    answer: CopilotExitPlanResponse,
  ): void {
    const key = this.pendingInteractionKey(sessionId, requestId)
    const pending = this.pendingExitPlans.get(key)
    if (!pending) {
      throw new CopilotRuntimeError(`No pending Copilot exit-plan request ${requestId}`)
    }
    if (answer.selectedAction && !pending.value.actions.includes(answer.selectedAction)) {
      throw new CopilotRuntimeError(
        `Copilot exit-plan action ${answer.selectedAction} is not available`,
      )
    }
    this.pendingExitPlans.delete(key)
    pending.resolve(answer)
  }

  shutdown(): Promise<Error[]> {
    this.shutdownPromise ??= this.performShutdown()
    return this.shutdownPromise
  }

  private async ensureStarted(): Promise<void> {
    if (this.stopped) throw new CopilotRuntimeError("Copilot runtime is shut down")
    if (this.startPromise) return this.startPromise
    if (this.connection) return

    const start = this.startRuntime()
    this.startPromise = start
    try {
      await start
    } finally {
      if (this.startPromise === start) this.startPromise = null
    }
  }

  private async startRuntime(): Promise<void> {
    let command = this.command
    if (this.spawn === defaultSpawn && !/[\\/]/.test(command)) {
      const executable = findExecutableOnPath(command, { env: this.env })
      if (!executable) {
        throw new CopilotRuntimeError(
          `Failed to start Copilot CLI: ${command} was not found on PATH`,
        )
      }
      command = executable
    }
    const resolved = resolveAgentCommand(command, COPILOT_ARGS, { env: this.env })
    let child: CopilotRuntimeProcess
    try {
      child = this.spawn(resolved.command, resolved.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
        ...resolved.spawnOptions,
      })
    } catch (error) {
      throw new CopilotRuntimeError(`Failed to start Copilot CLI: ${errorFrom(error).message}`, {
        cause: error,
      })
    }
    let connection: MessageConnection
    let messageWriter: TeardownResilientStreamMessageWriter
    try {
      messageWriter = new TeardownResilientStreamMessageWriter(child.stdin)
      connection = createMessageConnection(
        new StreamMessageReader(child.stdout),
        messageWriter,
      )
    } catch (error) {
      if (!child.killed) {
        try {
          child.kill()
        } catch {
          // The failed transport may already have exited.
        }
      }
      throw new CopilotRuntimeError("Failed to initialize Copilot CLI transport", { cause: error })
    }
    this.child = child
    this.connection = connection
    this.messageWriter = messageWriter

    let stderrTail = ""
    let startupFailure: Error | null = null
    const withDiagnostic = (message: string, cause?: unknown): CopilotRuntimeError => {
      const diagnostic = stderrTail.trim()
      return new CopilotRuntimeError(
        diagnostic ? `${message}: ${diagnostic}` : message,
        cause === undefined ? undefined : { cause },
      )
    }
    const failTransport = (error: Error) => {
      startupFailure = error
      this.discardTransport(connection, child, error)
    }
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-MAX_STDERR_TAIL)
    })
    child.on("error", (error) => {
      failTransport(withDiagnostic(`Failed to start Copilot CLI: ${error.message}`, error))
    })
    child.on("close", (code, signal) => {
      const exit = code === null ? signal ?? "unknown signal" : `code ${code}`
      failTransport(withDiagnostic(`Copilot CLI process exited with ${exit}`))
    })
    connection.onError(([error]) => {
      failTransport(withDiagnostic(`Copilot CLI connection failed: ${error.message}`, error))
    })
    connection.onClose(() => {
      failTransport(withDiagnostic("Copilot CLI connection closed"))
    })
    connection.onNotification("session.event", (params) => this.handleSessionEvent(params))
    connection.onNotification("session.lifecycle", (params) => this.handleLifecycle(params))
    connection.onRequest("userInput.request", (params) => this.handleUserInputRequest(params))
    connection.onRequest("exitPlanMode.request", (params) => this.handleExitPlanModeRequest(params))

    try {
      connection.listen()
      const response = await this.waitForRequest(
        connection.sendRequest<unknown>("connect", {}),
        "connect",
      )
      if (
        !isObject(response)
        || response.ok !== true
        || response.protocolVersion !== PROTOCOL_VERSION
      ) {
        const actual = isObject(response) ? String(response.protocolVersion) : "unknown"
        throw new CopilotRuntimeError(
          `Unsupported Copilot CLI protocol ${actual}; expected ${PROTOCOL_VERSION}`,
        )
      }
    } catch (error) {
      const failure = startupFailure ?? errorFrom(error)
      this.discardTransport(connection, child, failure)
      if (failure instanceof CopilotRuntimeError) throw failure
      throw new CopilotRuntimeError(`Failed to start Copilot CLI: ${failure.message}`, {
        cause: failure,
      })
    }
  }

  private async request<T>(method: string, params: CopilotJsonObject): Promise<T> {
    await this.ensureStarted()
    const connection = this.connection
    if (!connection) throw new CopilotRuntimeError("Copilot CLI connection closed")
    const child = this.child
    const cancellation = new CancellationTokenSource()
    try {
      return await this.waitForRequest(
        connection.sendRequest<T>(method, params, cancellation.token),
        method,
        this.requestTimeoutMs,
        () => cancellation.cancel(),
      )
    } catch (error) {
      if (
        error instanceof CopilotRequestTimeoutError
        && method !== "session.send"
        && MUTATING_RPC_METHODS.has(method)
        && child
      ) {
        this.discardTransport(connection, child, error, "SIGKILL")
      }
      if (error instanceof CopilotRuntimeError) throw error
      throw new CopilotRuntimeError(`Copilot CLI ${method} failed: ${errorFrom(error).message}`, {
        cause: error,
      })
    } finally {
      cancellation.dispose()
    }
  }

  private waitForRequest<T>(
    request: Promise<T>,
    method: string,
    timeoutMs = this.transportTimeoutMs,
    onTimeout?: () => void,
  ): Promise<T> {
    if (timeoutMs <= 0) return request
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          onTimeout?.()
        } catch {
          // Mutating requests are still contained after advisory cancellation fails.
        }
        reject(new CopilotRequestTimeoutError(method))
      }, timeoutMs)
      request.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(errorFrom(error))
        },
      )
    })
  }

  private async containTimedOutSend(
    sessionId: string,
    timeoutError: CopilotRequestTimeoutError,
  ): Promise<void> {
    const connection = this.connection
    const child = this.child
    if (!connection || !child) {
      this.clearSessionState(sessionId, timeoutError.message)
      return
    }

    const cancellation = new CancellationTokenSource()
    try {
      await this.waitForRequest(
        connection.sendRequest("session.abort", { sessionId }, cancellation.token),
        "session.abort",
        this.transportTimeoutMs,
        () => cancellation.cancel(),
      )
      if (this.connection !== connection || this.child !== child) return
      this.activeTurns.delete(sessionId)
      this.clearPendingInteractions(
        sessionId,
        "Copilot turn was aborted after session.send timed out",
      )
    } catch (error) {
      this.discardTransport(
        connection,
        child,
        new CopilotRuntimeError(
          `Failed to abort timed-out Copilot session ${sessionId}: ${errorFrom(error).message}`,
          { cause: error },
        ),
        "SIGKILL",
      )
    } finally {
      cancellation.dispose()
    }
  }

  private parseSessionOpenResult(method: string, response: unknown): CopilotSessionOpenResult {
    if (!isObject(response)) {
      throw new CopilotRuntimeError(`Copilot CLI ${method} returned an invalid response`)
    }
    requiredString(response, "sessionId", method)
    return response as CopilotSessionOpenResult
  }

  private assertSessionAvailable(sessionId: string): void {
    if (this.activeSessions.has(sessionId) || this.openingSessions.has(sessionId)) {
      throw new CopilotRuntimeError(`Copilot session ${sessionId} is already active`)
    }
  }

  private assertSessionActive(sessionId: string): void {
    if (!this.activeSessions.has(sessionId)) {
      throw new CopilotRuntimeError(`Copilot session ${sessionId} is not active`)
    }
  }

  private handleSessionEvent(params: unknown): void {
    if (!isObject(params) || typeof params.sessionId !== "string" || !isObject(params.event)) {
      return
    }
    const event = params.event
    if (typeof event.type !== "string") return
    const notification: CopilotSessionEventNotification = {
      sessionId: params.sessionId,
      event: event as CopilotSessionEvent,
    }
    this.updateResumeConflict(notification)
    this.updateTurnState(notification)
    this.updatePendingPermission(notification)
  }

  private handleLifecycle(params: unknown): void {
    if (
      !isObject(params)
      || typeof params.type !== "string"
      || typeof params.sessionId !== "string"
    ) {
      return
    }
    if (params.type === "session.deleted") {
      this.clearSessionState(params.sessionId, "Copilot session was deleted")
    }
  }

  private updatePendingPermission(notification: CopilotSessionEventNotification): void {
    const { event, sessionId } = notification
    if (!isObject(event.data)) return
    const requestId = event.data.requestId
    if (typeof requestId !== "string") return

    if (event.type === "permission.completed") {
      this.removePendingPermission(sessionId, requestId)
      return
    }
    if (event.type !== "permission.requested" || event.data.resolvedByHook === true) return

    const requests = this.pendingPermissions.get(sessionId) ?? new Map()
    requests.set(requestId, {
      sessionId,
      requestId,
      request: event.data.promptRequest ?? event.data.permissionRequest,
      rawRequest: event.data.permissionRequest,
      requestedAt: typeof event.timestamp === "string"
        ? Date.parse(event.timestamp) || Date.now()
        : Date.now(),
    })
    this.pendingPermissions.set(sessionId, requests)
  }

  private removePendingPermission(sessionId: string, requestId: string): void {
    const requests = this.pendingPermissions.get(sessionId)
    if (!requests?.delete(requestId)) return
    if (requests.size === 0) this.pendingPermissions.delete(sessionId)
  }

  private handleUserInputRequest(params: unknown): Promise<CopilotUserInputAnswer> {
    if (
      !isObject(params)
      || typeof params.sessionId !== "string"
      || typeof params.question !== "string"
    ) {
      throw new CopilotRuntimeError("Invalid Copilot user input request")
    }
    if (
      !this.activeSessions.has(params.sessionId)
      && !this.openingSessions.has(params.sessionId)
    ) {
      throw new CopilotRuntimeError(`Copilot session ${params.sessionId} is not active`)
    }

    const sessionId = params.sessionId
    const requestId = typeof params.requestId === "string" ? params.requestId : randomUUID()
    const choices = Array.isArray(params.choices)
      ? params.choices.filter((choice): choice is string => typeof choice === "string")
      : undefined
    const value: CopilotPendingUserInput = {
      sessionId,
      requestId,
      question: params.question,
      ...(choices ? { choices } : {}),
      ...(typeof params.allowFreeform === "boolean"
        ? { allowFreeform: params.allowFreeform }
        : {}),
      askedAt: Date.now(),
    }
    return new Promise<CopilotUserInputAnswer>((resolve, reject) => {
      this.pendingUserInputs.set(
        this.pendingInteractionKey(sessionId, requestId),
        { value, resolve, reject },
      )
    })
  }

  private handleExitPlanModeRequest(params: unknown): Promise<CopilotExitPlanResponse> {
    if (
      !isObject(params)
      || typeof params.sessionId !== "string"
      || (!this.activeSessions.has(params.sessionId) && !this.openingSessions.has(params.sessionId))
    ) {
      throw new CopilotRuntimeError("Invalid Copilot exit-plan request")
    }
    const sessionId = params.sessionId
    const requestId = randomUUID()
    const actions = Array.isArray(params.actions)
      ? params.actions.filter((action): action is string => typeof action === "string")
      : []
    const value: CopilotPendingExitPlan = {
      sessionId,
      requestId,
      summary: typeof params.summary === "string" ? params.summary : "Plan ready for review",
      ...(typeof params.planContent === "string" ? { planContent: params.planContent } : {}),
      actions,
      recommendedAction: typeof params.recommendedAction === "string"
        ? params.recommendedAction
        : actions[0] ?? "interactive",
      askedAt: Date.now(),
    }
    return new Promise<CopilotExitPlanResponse>((resolve, reject) => {
      this.pendingExitPlans.set(
        this.pendingInteractionKey(sessionId, requestId),
        { value, resolve, reject },
      )
    })
  }

  private pendingInteractionKey(sessionId: string, requestId: string): string {
    return `${sessionId}\0${requestId}`
  }

  private clearSessionState(sessionId: string, reason: string): void {
    this.activeSessions.delete(sessionId)
    this.activeTurns.delete(sessionId)
    this.sendingSessions.delete(sessionId)
    this.openingSessions.delete(sessionId)
    this.conflictingResumes.delete(sessionId)
    this.clearPendingInteractions(sessionId, reason)
  }

  private clearPendingInteractions(sessionId: string, reason: string): void {
    this.pendingPermissions.delete(sessionId)

    for (const [key, pending] of this.pendingUserInputs) {
      if (pending.value.sessionId !== sessionId) continue
      this.pendingUserInputs.delete(key)
      pending.reject(new CopilotRuntimeError(reason))
    }

    for (const [key, pending] of this.pendingExitPlans) {
      if (pending.value.sessionId !== sessionId) continue
      this.pendingExitPlans.delete(key)
      pending.reject(new CopilotRuntimeError(reason))
    }
  }

  private updateTurnState(notification: CopilotSessionEventNotification): void {
    if (typeof notification.event.agentId === "string" && notification.event.agentId) return
    if (notification.event.type === "assistant.turn_start") {
      this.activeTurns.add(notification.sessionId)
      return
    }
    if (
      notification.event.type === "abort"
      || notification.event.type === "session.error"
      || notification.event.type === "session.idle"
      || notification.event.type === "session.shutdown"
    ) {
      this.activeTurns.delete(notification.sessionId)
      if (
        notification.event.type === "abort"
        || notification.event.type === "session.error"
      ) {
        this.clearPendingInteractions(
          notification.sessionId,
          notification.event.type === "abort"
            ? "Copilot turn was aborted"
            : "Copilot turn failed",
        )
      }
    }
  }

  private updateResumeConflict(notification: CopilotSessionEventNotification): void {
    const { event, sessionId } = notification
    if (
      event.type !== "session.resume"
      || (typeof event.agentId === "string" && event.agentId.length > 0)
      || !this.openingSessions.has(sessionId)
      || !isObject(event.data)
      || event.data.alreadyInUse !== true
    ) {
      return
    }
    this.conflictingResumes.add(sessionId)
  }

  private discardTransport(
    connection: MessageConnection,
    child: CopilotRuntimeProcess,
    reason: Error,
    killSignal?: NodeJS.Signals | number,
  ): void {
    if (this.connection !== connection || this.child !== child) return
    if (this.messageWriter) this.messageWriter.suppressWriteErrors = true
    this.connection = null
    this.child = null
    this.messageWriter = null
    this.permissionModeRpc = "unknown"
    try {
      connection.dispose()
    } catch {
      // The connection may already be closed.
    }
    if (!child.killed) {
      try {
        child.kill(killSignal)
      } catch {
        // The process may already have exited.
      }
    }

    for (const sessionId of [...this.activeSessions, ...this.openingSessions]) {
      this.clearSessionState(sessionId, reason.message)
    }
    this.pendingPermissions.clear()
    if (this.pendingUserInputs.size > 0) {
      for (const pending of this.pendingUserInputs.values()) pending.reject(reason)
      this.pendingUserInputs.clear()
    }
  }

  private async performShutdown(): Promise<Error[]> {
    this.stopped = true
    this.activeTurns.clear()
    const errors: Error[] = []
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch (error) {
        errors.push(errorFrom(error))
      }
    }

    const connection = this.connection
    const child = this.child
    if (!connection || !child) return errors

    const destroyed = await Promise.allSettled(
      [...this.activeSessions].map((sessionId) =>
        this.waitForRequest(
          connection.sendRequest("session.destroy", { sessionId }),
          "session.destroy",
        )),
    )
    for (const result of destroyed) {
      if (result.status === "rejected") errors.push(errorFrom(result.reason))
    }
    try {
      await this.waitForRequest(
        connection.sendRequest("runtime.shutdown", {}),
        "runtime.shutdown",
      )
    } catch (error) {
      errors.push(errorFrom(error))
    }
    this.discardTransport(
      connection,
      child,
      new CopilotRuntimeError("Copilot runtime was shut down"),
    )
    return errors
  }
}

export const copilotRuntime = new CopilotRuntime()
