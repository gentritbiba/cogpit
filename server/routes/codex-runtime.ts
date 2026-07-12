import type { IncomingMessage, ServerResponse } from "node:http"
import {
  CodexAppServerError,
  CodexAppServerRpcError,
  CODEX_CLIENT_CAPABILITIES,
  codexAppServer,
  type CodexAppServer,
  type InitializeResult,
  type JsonObject,
  type ThreadGoalSetParams,
  type UserInput,
} from "../codex-app-server"
import { sendJson, type UseFn } from "../helpers"

export type CodexRuntimeClient = Pick<
  CodexAppServer,
  | "start"
  | "call"
  | "getGoal"
  | "setGoal"
  | "clearGoal"
  | "steerTurn"
  | "interruptTurn"
>

type RuntimeSection =
  | "account"
  | "usage"
  | "rateLimits"
  | "experimentalFeatures"
  | "permissionProfiles"

interface SectionResult {
  value: unknown | null
  error?: string
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const GOAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
])

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function pathParts(url: string | undefined): string[] {
  return new URL(url || "/", "http://localhost").pathname
    .split("/")
    .filter(Boolean)
}

function parseThreadId(segment: string | undefined, field = "threadId"): string {
  let value: string
  try {
    value = decodeURIComponent(segment ?? "")
  } catch {
    throw new RequestError(400, "INVALID_THREAD_ID", `${field} is invalid`)
  }
  if (!THREAD_ID_PATTERN.test(value)) {
    throw new RequestError(
      400,
      "INVALID_THREAD_ID",
      `${field} must be a valid Codex identifier`,
    )
  }
  return value
}

function readJsonBody(
  req: IncomingMessage,
  options: { allowEmpty?: boolean } = {},
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      if (!body.trim() && options.allowEmpty) {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(body)
        if (!isObject(parsed)) {
          throw new RequestError(
            400,
            "INVALID_REQUEST",
            "Request body must be a JSON object",
          )
        }
        resolve(parsed)
      } catch (error) {
        reject(
          error instanceof RequestError
            ? error
            : new RequestError(400, "INVALID_JSON", "Invalid JSON body"),
        )
      }
    })
    req.on("error", (error) => reject(error))
  })
}

function sendRouteError(res: ServerResponse, error: unknown): void {
  if (error instanceof RequestError) {
    sendJson(res, error.status, { error: error.message, code: error.code })
    return
  }
  if (error instanceof CodexAppServerRpcError) {
    const status =
      error.code === -32602 ? 400 : error.code === -32601 ? 501 : 502
    sendJson(res, status, {
      error: error.message,
      code: "CODEX_RPC_ERROR",
      rpcCode: error.code,
    })
    return
  }
  if (error instanceof CodexAppServerError) {
    const noActiveTurn = error.message.startsWith("No active turn is known")
    sendJson(res, noActiveTurn ? 409 : 503, {
      error: error.message,
      code: noActiveTurn ? "NO_ACTIVE_TURN" : "CODEX_UNAVAILABLE",
    })
    return
  }
  sendJson(res, 500, {
    error: errorMessage(error),
    code: "INTERNAL_ERROR",
  })
}

async function bestEffort(promise: Promise<unknown>): Promise<SectionResult> {
  try {
    return { value: await promise }
  } catch (error) {
    return { value: null, error: errorMessage(error) }
  }
}

function readString(object: JsonObject, key: string): string | null {
  const value = object[key]
  return typeof value === "string" ? value : null
}

function runtimeVersion(initialize: InitializeResult): string | null {
  const explicit = readString(initialize, "version")
  if (explicit) return explicit
  const userAgent = readString(initialize, "userAgent")
  if (!userAgent) return null
  return (
    userAgent.match(/(?:codex(?:-cli|_cli_rs)?)[/ ]v?([\w.-]+)/i)?.[1] ??
    userAgent.match(/^[^/\s]+\/v?([\w.-]+)/)?.[1] ??
    userAgent
  )
}

async function handleRuntime(
  res: ServerResponse,
  client: CodexRuntimeClient,
): Promise<void> {
  let initialize: InitializeResult
  try {
    initialize = await client.start()
  } catch (error) {
    const message = errorMessage(error)
    sendJson(res, 200, {
      available: false,
      version: null,
      userAgent: null,
      capabilities: null,
      account: null,
      usage: null,
      rateLimits: null,
      experimentalFeatures: null,
      permissionProfiles: null,
      errors: { runtime: message },
    })
    return
  }

  const sectionNames: RuntimeSection[] = [
    "account",
    "usage",
    "rateLimits",
    "experimentalFeatures",
    "permissionProfiles",
  ]
  const results = await Promise.all([
    bestEffort(client.call("account/read", { refreshToken: false })),
    bestEffort(client.call("account/usage/read")),
    bestEffort(client.call("account/rateLimits/read")),
    bestEffort(client.call("experimentalFeature/list", {})),
    bestEffort(client.call("permissionProfile/list", {})),
  ])
  const sections: Record<RuntimeSection, unknown | null> = {
    account: null,
    usage: null,
    rateLimits: null,
    experimentalFeatures: null,
    permissionProfiles: null,
  }
  const errors: Partial<Record<RuntimeSection, string>> = {}
  results.forEach((result, index) => {
    const name = sectionNames[index]
    sections[name] = result.value
    if (result.error) errors[name] = result.error
  })

  const userAgent = readString(initialize, "userAgent")
  sendJson(res, 200, {
    available: true,
    version: runtimeVersion(initialize),
    userAgent,
    capabilities: {
      experimentalApi: CODEX_CLIENT_CAPABILITIES.experimentalApi,
      platformFamily: initialize.platformFamily ?? null,
      platformOs: initialize.platformOs ?? null,
      codexHome: initialize.codexHome ?? null,
    },
    ...sections,
    errors,
  })
}

function parseGoalUpdate(body: JsonObject): Omit<ThreadGoalSetParams, "threadId"> {
  const update: Omit<ThreadGoalSetParams, "threadId"> = {}
  if (Object.hasOwn(body, "objective")) {
    if (
      typeof body.objective !== "string" ||
      body.objective.trim().length === 0 ||
      body.objective.length > 4_000
    ) {
      throw new RequestError(
        400,
        "INVALID_GOAL",
        "objective must be a non-empty string of at most 4000 characters",
      )
    }
    update.objective = body.objective
  }
  if (Object.hasOwn(body, "status")) {
    if (typeof body.status !== "string" || !GOAL_STATUSES.has(body.status)) {
      throw new RequestError(400, "INVALID_GOAL", "status is invalid")
    }
    update.status = body.status
  }
  if (Object.hasOwn(body, "tokenBudget")) {
    if (
      body.tokenBudget !== null &&
      (!Number.isSafeInteger(body.tokenBudget) ||
        (body.tokenBudget as number) <= 0)
    ) {
      throw new RequestError(
        400,
        "INVALID_GOAL",
        "tokenBudget must be a positive integer or null",
      )
    }
    update.tokenBudget = body.tokenBudget as number | null
  }
  if (Object.keys(update).length === 0) {
    throw new RequestError(
      400,
      "INVALID_GOAL",
      "At least one goal field is required",
    )
  }
  return update
}

function parseSteerInput(body: JsonObject): string | UserInput[] {
  const input = body.input
  if (typeof input === "string") {
    if (!input.trim()) {
      throw new RequestError(400, "INVALID_INPUT", "input cannot be empty")
    }
    return input
  }
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    !input.every(
      (item) =>
        isObject(item) && typeof item.type === "string" && item.type.length > 0,
    )
  ) {
    throw new RequestError(
      400,
      "INVALID_INPUT",
      "input must be a non-empty string or Codex input array",
    )
  }
  return input as UserInput[]
}

async function handleGoal(
  req: IncomingMessage,
  res: ServerResponse,
  client: CodexRuntimeClient,
  threadId: string,
): Promise<void> {
  if (req.method === "GET") {
    sendJson(res, 200, await client.getGoal(threadId))
    return
  }
  if (req.method === "POST") {
    const update = parseGoalUpdate(await readJsonBody(req))
    sendJson(res, 200, await client.setGoal(threadId, update))
    return
  }
  sendJson(res, 200, await client.clearGoal(threadId))
}

async function handleThreadAction(
  req: IncomingMessage,
  res: ServerResponse,
  client: CodexRuntimeClient,
  threadId: string,
  action: string,
): Promise<void> {
  if (action === "steer") {
    const body = await readJsonBody(req)
    const input = parseSteerInput(body)
    const expectedTurnId = Object.hasOwn(body, "expectedTurnId")
      ? parseThreadId(String(body.expectedTurnId ?? ""), "expectedTurnId")
      : undefined
    sendJson(res, 200, await client.steerTurn(threadId, input, expectedTurnId))
    return
  }

  const body = await readJsonBody(req, { allowEmpty: true })
  const turnId = Object.hasOwn(body, "turnId")
    ? parseThreadId(String(body.turnId ?? ""), "turnId")
    : undefined
  await client.interruptTurn(threadId, turnId)
  sendJson(res, 200, { success: true, ...(turnId ? { turnId } : {}) })
}

export function registerCodexRuntimeRoutes(
  use: UseFn,
  client: CodexRuntimeClient = codexAppServer,
): void {
  use("/api/codex/runtime", (req, res, next) => {
    if (req.method !== "GET" || pathParts(req.url).length !== 0) {
      next()
      return
    }
    void handleRuntime(res, client).catch((error) => sendRouteError(res, error))
  })

  use("/api/codex/goals", (req, res, next) => {
    const parts = pathParts(req.url)
    if (
      parts.length !== 1 ||
      (req.method !== "GET" &&
        req.method !== "POST" &&
        req.method !== "DELETE")
    ) {
      next()
      return
    }
    try {
      const threadId = parseThreadId(parts[0])
      void handleGoal(req, res, client, threadId).catch((error) =>
        sendRouteError(res, error),
      )
    } catch (error) {
      sendRouteError(res, error)
    }
  })

  use("/api/codex/threads", (req, res, next) => {
    const parts = pathParts(req.url)
    if (
      req.method !== "POST" ||
      parts.length !== 2 ||
      (parts[1] !== "steer" && parts[1] !== "interrupt")
    ) {
      next()
      return
    }
    try {
      const threadId = parseThreadId(parts[0])
      void handleThreadAction(req, res, client, threadId, parts[1]).catch(
        (error) => sendRouteError(res, error),
      )
    } catch (error) {
      sendRouteError(res, error)
    }
  })
}
