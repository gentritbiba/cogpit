// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockList = vi.hoisted(() => vi.fn())
const mockMarkRead = vi.hoisted(() => vi.fn())
const mockMarkAllRead = vi.hoisted(() => vi.fn())

vi.mock("../../lib/notificationHistory", () => ({
  listNotifications: mockList,
  markNotificationsRead: mockMarkRead,
  markAllNotificationsRead: mockMarkAllRead,
}))

import { Readable } from "node:stream"
import type { IncomingMessage } from "node:http"
import type { UseFn, Middleware } from "../../helpers"
import { asServerResponse, getRouteHandler } from "../http-fixtures"
import { registerNotificationRoutes } from "../../routes/notifications"

/** Request double whose body is a real stream, so readJsonBody works. */
function makeRequest(method: string, url: string, body?: string): IncomingMessage {
  const stream = Readable.from(body !== undefined ? [Buffer.from(body)] : [])
  return Object.assign(stream, { method, url, headers: {} }) as unknown as IncomingMessage
}

function buildHandler(): Middleware {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => {
    handlers.set(path, handler)
  }
  registerNotificationRoutes(use)
  return getRouteHandler(handlers, "/api/notifications")
}

async function request(method: string, url: string, body?: unknown) {
  let responseBody = ""
  const res = asServerResponse({
    statusCode: 200,
    setHeader: vi.fn(),
    end: (data?: string) => { responseBody = data ?? "" },
  })
  const next = vi.fn()
  const req = makeRequest(method, url, body !== undefined ? JSON.stringify(body) : undefined)
  await buildHandler()(req, res, next)
  return { res, next, json: () => JSON.parse(responseBody) as Record<string, unknown> }
}

const ENTRY = {
  id: "n-1",
  at: "2026-08-19T10:00:00.000Z",
  title: "Claude Code — proj",
  body: "Waiting for your input",
  kind: "turnComplete",
  sessionId: "s1",
  dirName: "-d",
  readAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockList.mockResolvedValue([ENTRY])
  mockMarkRead.mockResolvedValue(undefined)
  mockMarkAllRead.mockResolvedValue(undefined)
})

describe("GET /api/notifications", () => {
  it("returns the notification list", async () => {
    const { res, json } = await request("GET", "/")
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ notifications: [ENTRY] })
    expect(mockList).toHaveBeenCalledWith(100)
  })

  it("honors the limit parameter", async () => {
    await request("GET", "/?limit=5")
    expect(mockList).toHaveBeenCalledWith(5)
  })

  it("falls back to the default on a malformed limit", async () => {
    await request("GET", "/?limit=banana")
    expect(mockList).toHaveBeenCalledWith(100)
  })
})

describe("POST /api/notifications/read", () => {
  it("marks the given ids read", async () => {
    const { res, json } = await request("POST", "/read", { ids: ["n-1", "n-2"] })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ success: true })
    expect(mockMarkRead).toHaveBeenCalledWith(["n-1", "n-2"])
  })

  it("marks everything read with { all: true }", async () => {
    const { res } = await request("POST", "/read", { all: true })
    expect(res.statusCode).toBe(200)
    expect(mockMarkAllRead).toHaveBeenCalledOnce()
  })

  it("rejects a body with neither ids nor all", async () => {
    const { res } = await request("POST", "/read", { ids: "n-1" })
    expect(res.statusCode).toBe(400)
    expect(mockMarkRead).not.toHaveBeenCalled()
  })

  it("rejects malformed JSON", async () => {
    let responseBody = ""
    const res = asServerResponse({
      statusCode: 200,
      setHeader: vi.fn(),
      end: (data?: string) => { responseBody = data ?? "" },
    })
    const req = makeRequest("POST", "/read", "{ not json")
    await buildHandler()(req, res, vi.fn())
    expect(res.statusCode).toBe(400)
    expect(responseBody).toContain("Invalid JSON")
  })
})

describe("unmatched requests", () => {
  it("falls through to next for unknown methods", async () => {
    const { next } = await request("DELETE", "/")
    expect(next).toHaveBeenCalledOnce()
  })

  it("falls through to next for unknown subpaths", async () => {
    const { next } = await request("POST", "/frobnicate")
    expect(next).toHaveBeenCalledOnce()
  })
})
