import type { IncomingMessage } from "node:http"

/**
 * Every event Cogpit may send, with the properties each one carries. Values
 * are short tokens, numbers or booleans: `sanitizeProperties` drops anything
 * else, so a path, a prompt or an error message cannot leave even by mistake.
 */
export interface TelemetryEvents {
  "app.heartbeat": {
    reason: "start" | "daily"
    freshInstall: boolean
    defaultAgent?: string
  }
  "session.started": TurnProperties & {
    worktree: boolean
  }
  "message.sent": TurnProperties & {
    delivery: string
    route: string
  }
  "usage.daily": {
    day: string
    agent: string
    model: string
    inputTokens: number
    cachedInputTokens: number
    cacheWriteTokens: number
    outputTokens: number
    reasoningTokens: number
    responses: number
    sessions: number
    costUsd: number
    costSource: string
  }
  "turn.completed": {
    agent: string
    model?: string
    effort?: string
    durationMs?: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    fastMode: boolean
    toolCalls: number
    toolErrors: number
    linesAdded: number
    linesRemoved: number
    subagents: number
    compaction?: string
    /** Whether a skill, plugin or MCP server took part; never which one. */
    skill: boolean
    plugin: boolean
    mcp: boolean
    images: number
  }
  "tool.used": {
    agent: string
    /** A built-in tool's name, or `mcp` / `other`. */
    tool: string
    calls: number
    errors: number
  }
  "agent.status": {
    agent: string
    installed: boolean
    signedIn: boolean | "unknown"
    version?: string
  }
  "agent.error": {
    agent: string
    phase: "start" | "turn"
    reason: string
    httpStatus?: number
  }
  "feature.used": {
    feature: string
    client: ClientSurface
  }
}

export type TelemetryEventName = keyof TelemetryEvents

interface TurnProperties {
  agent: string
  /** A separately configured copy of an agent; its name is the user's, so only the fact is sent. */
  instance: boolean
  model?: string
  effort?: string
  permissionMode?: string
  fastMode?: boolean
  client: ClientSurface
}

export type ClientSurface = "desktop" | "browser" | "mobile" | "agent" | "hub" | "other"

export type TelemetryValue = string | number | boolean
export type TelemetryProperties = Record<string, TelemetryValue>

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/

/** The properties that are safe to send, rounded where they are measurements. */
export function sanitizeProperties(properties: object): TelemetryProperties {
  const clean: TelemetryProperties = {}
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "boolean") clean[key] = value
    else if (typeof value === "number" && Number.isFinite(value)) clean[key] = Math.round(value * 1e6) / 1e6
    else if (typeof value === "string" && TOKEN.test(value)) clean[key] = value
  }
  return clean
}

/** A short closed-form setting such as an effort or permission mode, or nothing. */
export function settingToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value) ? value : undefined
}

/** The full path of a request, also inside a route mounted under a prefix. */
export function requestPath(req: IncomingMessage): string {
  const target = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? ""
  return target.split("?")[0]
}

/** Which kind of client made a request, from headers every client already sends. */
export function clientSurface(req: IncomingMessage | undefined): ClientSurface {
  if (!req) return "other"
  if (req.headers["x-cogpit-session-scope"]) return "hub"
  if (requestPath(req).startsWith("/api/session-cli")) return "agent"
  const agent = String(req.headers["user-agent"] ?? "")
  if (/\bElectron\//.test(agent)) return "desktop"
  if (/iPhone|iPad|Android|Mobile/.test(agent)) return "mobile"
  if (/^Mozilla\//.test(agent)) return "browser"
  return "other"
}
