import type { IncomingMessage, ServerResponse } from "node:http"
import type { Dirent } from "node:fs"
import { vi, type Mock } from "vitest"

import type { Middleware, UseFn } from "../helpers"
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

export function asIncomingMessage<T extends object>(request: T): T & IncomingMessage {
  return request as T & IncomingMessage
}

export function asServerResponse<T extends object>(response: T): T & ServerResponse {
  return response as T & ServerResponse
}

type MockReqResOptions = {
  body?: string
  headers?: Record<string, string>
  remoteAddress?: string
  socketPort?: number
}

/**
 * Request/response doubles for route tests: `sendBody` replays the body to the
 * handlers the route registered, and the `_get*` accessors read back what the
 * route wrote.
 */
export function createMockReqRes(method: string, url = "/", opts: MockReqResOptions = {}) {
  const dataHandlers: ((chunk: Buffer) => void)[] = []
  const endHandlers: (() => void)[] = []
  let endData = ""
  let statusCode = 200
  const headers: Record<string, string> = {}
  const req = {
    method,
    url,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: Buffer) => void)
      if (event === "end") endHandlers.push(handler as () => void)
      return req
    }),
    socket: {
      remoteAddress: opts.remoteAddress ?? "127.0.0.1",
      address: () => ({ port: opts.socketPort ?? 19384 }),
    },
    headers: opts.headers ?? {},
  }
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn((name: string, value: string) => { headers[name] = value }),
    end: vi.fn((data?: string) => { endData = data || "" }),
    write: vi.fn(),
    writeHead: vi.fn(),
    _getData: () => endData,
    _getStatus: () => statusCode,
    _getHeaders: () => headers,
  }
  const next = vi.fn()
  const sendBody = () => {
    if (opts.body) for (const h of dataHandlers) h(Buffer.from(opts.body))
    for (const h of endHandlers) h()
  }
  return { req: asIncomingMessage(req), res: asServerResponse(res), next, sendBody }
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

/** Run a route registrar and return the path -> handler map it produced. */
export function collectRoutes(register: (use: UseFn) => void): Map<string, Middleware> {
  const handlers = new Map<string, Middleware>()
  register((path, handler) => { handlers.set(path, handler) })
  return handlers
}

/** Response double for middleware tests: records the status and body written. */
export function createMiddlewareRes(): { res: ServerResponse; body: string; statusCode: number } {
  let body = ""
  let statusCode = 200
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn(),
    end: (data?: string) => { body = data || "" },
    once: vi.fn(),
    destroy: vi.fn(),
    writableEnded: false,
  } as unknown as ServerResponse
  return { res, get body() { return body }, get statusCode() { return statusCode } }
}
