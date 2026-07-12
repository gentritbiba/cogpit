import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  CodexAppServerError,
  CodexAppServerRpcError,
  type CodexThread,
  type JsonObject,
  type ThreadResponse,
  type TurnResponse,
  type TurnSteerResponse,
  type UserInput,
} from "../codex-app-server"
import { CODEX_SESSIONS_DIR } from "../helpers"

export interface CodexExecutionClient {
  start(): Promise<unknown>
  startThread(params?: JsonObject): Promise<ThreadResponse>
  resumeThread(threadId: string, options?: JsonObject): Promise<ThreadResponse>
  startTurn(params: JsonObject & { threadId: string; input: UserInput[] }): Promise<TurnResponse>
  steerTurn(
    threadId: string,
    input: UserInput[],
    expectedTurnId?: string,
  ): Promise<TurnSteerResponse>
  interruptTurn(threadId: string, turnId?: string): Promise<JsonObject>
  getActiveTurnId(threadId: string): string | undefined
  call<T = unknown>(method: string, params?: unknown): Promise<T>
}

export interface CodexImageInput {
  data: string
  mediaType: string
}

export interface CodexExecutionOptions {
  message?: string
  images?: CodexImageInput[]
  cwd: string
  permissions?: { mode?: string }
  model?: string
  effort?: string
  fastMode?: boolean
}

export interface CodexThreadIdentity {
  sessionId: string
  fileName: string
  filePath: string
}

export interface CodexContinuationResult {
  action: "started" | "steered"
  threadId: string
  turnId: string
}

type ApprovalPolicy = "on-request" | "never"
type SandboxMode = "workspace-write" | "read-only" | "danger-full-access"

export interface CodexAccessSettings {
  approvalPolicy: ApprovalPolicy
  sandbox: SandboxMode
}

class CodexCompatibilityUnavailableError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = "CodexCompatibilityUnavailableError"
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

/** Translate Cogpit's access picker into Codex's native thread policy. */
export function buildCodexAccessSettings(
  permissions?: { mode?: string },
): CodexAccessSettings {
  switch (permissions?.mode) {
    case "bypassPermissions":
      return { approvalPolicy: "never", sandbox: "danger-full-access" }
    case "plan":
      return { approvalPolicy: "never", sandbox: "read-only" }
    default:
      return { approvalPolicy: "on-request", sandbox: "workspace-write" }
  }
}

function sandboxPolicy(mode: SandboxMode): JsonObject {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" }
  if (mode === "read-only") return { type: "readOnly", networkAccess: false }
  return {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

function serviceTier(fastMode: boolean | undefined): string | null | undefined {
  if (fastMode === true) return "priority"
  if (fastMode === false) return null
  return undefined
}

export function buildCodexUserInput(
  message?: string,
  images?: CodexImageInput[],
): UserInput[] {
  const input: UserInput[] = []
  if (message?.trim()) {
    input.push({ type: "text", text: message, text_elements: [] })
  }
  for (const image of Array.isArray(images) ? images : []) {
    if (!image || typeof image.data !== "string" || !image.data) continue
    const mediaType = nonEmpty(image.mediaType) ?? "image/png"
    const url = image.data.startsWith("data:")
      ? image.data
      : `data:${mediaType};base64,${image.data}`
    input.push({ type: "image", url })
  }
  return input
}

function threadSettings(options: CodexExecutionOptions): JsonObject {
  const access = buildCodexAccessSettings(options.permissions)
  const settings: JsonObject = {
    cwd: options.cwd,
    approvalPolicy: access.approvalPolicy,
    sandbox: access.sandbox,
  }
  const model = nonEmpty(options.model)
  if (model) settings.model = model
  const tier = serviceTier(options.fastMode)
  if (tier !== undefined) settings.serviceTier = tier
  return settings
}

function turnSettings(options: CodexExecutionOptions): JsonObject {
  const access = buildCodexAccessSettings(options.permissions)
  const settings: JsonObject = {
    cwd: options.cwd,
    approvalPolicy: access.approvalPolicy,
    sandboxPolicy: sandboxPolicy(access.sandbox),
  }
  const model = nonEmpty(options.model)
  const effort = nonEmpty(options.effort)
  const tier = serviceTier(options.fastMode)
  if (model) settings.model = model
  if (effort) settings.effort = effort
  if (tier !== undefined) settings.serviceTier = tier
  return settings
}

function activeTurnFromThread(thread: CodexThread): string | undefined {
  const turns = Array.isArray(thread.turns) ? thread.turns : []
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    if (
      turn
      && typeof turn === "object"
      && typeof turn.id === "string"
      && turn.status === "inProgress"
    ) {
      return turn.id
    }
  }
  return undefined
}

function isInitializationUnavailable(error: unknown): boolean {
  if (error instanceof CodexAppServerRpcError) return error.code === -32601
  if (error instanceof CodexAppServerError) return true
  if (typeof error !== "object" || error === null) return false
  const code = "code" in error ? String(error.code) : ""
  const message = "message" in error ? String(error.message) : ""
  return code === "ENOENT"
    || /app-server.*(?:unavailable|not found|unknown|unsupported|exited|failed|timed out)/i.test(message)
}

async function ensureCodexAppServer(client: CodexExecutionClient): Promise<void> {
  try {
    await client.start()
  } catch (error) {
    if (isInitializationUnavailable(error)) {
      throw new CodexCompatibilityUnavailableError(error)
    }
    throw error
  }
}

export async function startCodexExecution(
  client: CodexExecutionClient,
  options: CodexExecutionOptions,
): Promise<{ thread: CodexThread; turnId: string }> {
  await ensureCodexAppServer(client)
  const input = buildCodexUserInput(options.message, options.images)
  const response = await client.startThread(threadSettings(options))
  const turn = await client.startTurn({
    threadId: response.thread.id,
    input,
    ...turnSettings(options),
  })
  return { thread: response.thread, turnId: turn.turn.id }
}

export async function continueCodexExecution(
  client: CodexExecutionClient,
  threadId: string,
  path: string | null,
  options: CodexExecutionOptions,
): Promise<CodexContinuationResult> {
  await ensureCodexAppServer(client)
  const input = buildCodexUserInput(options.message, options.images)
  const knownTurnId = client.getActiveTurnId(threadId)

  if (knownTurnId) {
    const steered = await client.steerTurn(threadId, input, knownTurnId)
    return { action: "steered", threadId, turnId: steered.turnId }
  }

  const resumed = await client.resumeThread(threadId, {
    ...(path ? { path } : {}),
    ...threadSettings(options),
  })
  const resumedThreadId = resumed.thread.id || threadId
  const activeTurnId = client.getActiveTurnId(resumedThreadId)
    ?? activeTurnFromThread(resumed.thread)

  if (activeTurnId) {
    const steered = await client.steerTurn(resumedThreadId, input, activeTurnId)
    return {
      action: "steered",
      threadId: resumedThreadId,
      turnId: steered.turnId,
    }
  }

  const turn = await client.startTurn({
    threadId: resumedThreadId,
    input,
    ...turnSettings(options),
  })
  return {
    action: "started",
    threadId: resumedThreadId,
    turnId: turn.turn.id,
  }
}

/** Return a browser-safe nested filename only for rollout paths in CODEX_HOME. */
export function getCodexThreadIdentity(
  thread: CodexThread,
  sessionsDir = CODEX_SESSIONS_DIR,
): CodexThreadIdentity | null {
  const threadPath = typeof thread.path === "string" ? thread.path : ""
  if (!thread.id || !threadPath || !isAbsolute(threadPath)) return null

  const root = resolve(sessionsDir)
  const filePath = resolve(threadPath)
  const fileName = relative(root, filePath)
  if (
    !fileName
    || fileName === ".."
    || fileName.startsWith(`..${sep}`)
    || isAbsolute(fileName)
    || !fileName.endsWith(".jsonl")
  ) {
    return null
  }

  return {
    sessionId: thread.id,
    fileName: fileName.split(sep).join("/"),
    filePath,
  }
}

export function isCodexAppServerUnavailable(error: unknown): boolean {
  if (error instanceof CodexCompatibilityUnavailableError) return true
  if (error instanceof CodexAppServerRpcError) return error.code === -32601
  if (typeof error !== "object" || error === null) return false
  const code = "code" in error ? String(error.code) : ""
  return code === "ENOENT"
}
