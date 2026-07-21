import type { IncomingMessage, ServerResponse } from "node:http"
import type { Dirent } from "node:fs"
import type { Mock } from "vitest"

import type { Middleware } from "../helpers"
import type { SessionMeta } from "../lib/sessionMetaCache"

export type ReaddirTestEntry = string | Dirent<string>
export type ReaddirMock = Mock<(...args: unknown[]) => Promise<ReaddirTestEntry[]>>

/** Select the string/Dirent overload that route tests exercise. */
export function asReaddirMock(mock: object): ReaddirMock {
  return mock as ReaddirMock
}

/** Complete metadata fixture that stays aligned with the parser contract. */
export function makeSessionMeta(
  overrides: Partial<SessionMeta> & Record<string, unknown> = {},
): SessionMeta {
  return {
    sessionId: "session-1",
    version: "",
    gitBranch: "",
    model: "",
    slug: "",
    name: "",
    aiTitle: "",
    cwd: "",
    firstUserMessage: "",
    lastUserMessage: "",
    timestamp: "",
    lastTimestamp: "",
    turnCount: 0,
    lineCount: 0,
    branchedFrom: undefined,
    teamName: "",
    agentName: "",
    isSubagent: false,
    parentSessionId: null,
    ...overrides,
  } as SessionMeta
}

/**
 * Preserve the observable fields on a lightweight request double while
 * acknowledging the Node request contract at the test boundary.
 */
export function asIncomingMessage<T extends object>(request: T): T & IncomingMessage {
  return request as T & IncomingMessage
}

/**
 * Preserve test-only response inspection helpers while satisfying route
 * middleware's Node response contract.
 */
export function asServerResponse<T extends object>(response: T): T & ServerResponse {
  return response as T & ServerResponse
}

/** Fail clearly during test setup instead of invoking an optional handler. */
export function getRouteHandler(
  handlers: ReadonlyMap<string, Middleware>,
  path: string,
): Middleware {
  const handler = handlers.get(path)
  if (!handler) throw new Error(`Route was not registered: ${path}`)
  return handler
}
