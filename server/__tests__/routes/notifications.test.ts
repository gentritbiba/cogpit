// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// The history file lives in the real home directory; nothing here may touch it.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: vi.fn(async () => "[]"),
  mkdir: vi.fn(async () => undefined),
}))
vi.mock("../../atomicJsonFile", () => ({ writeOwnerOnlyText: vi.fn(async () => undefined) }))

import { Readable } from "node:stream"
import type { IncomingMessage } from "node:http"
import type { UseFn, Middleware } from "../../helpers"
import { asServerResponse, getRouteHandler } from "../http-fixtures"
import { registerNotificationRoutes } from "../../routes/notifications"
import {
  listNotifications,
  LOCAL_READER,
  resetNotificationHistoryForTests,
  type NotificationHistoryEntry,
} from "../../lib/notificationHistory"

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

async function request(method: string, url: string, body?: unknown, rawBody?: string) {
  let responseBody = ""
  const res = asServerResponse({
    statusCode: 200,
    setHeader: vi.fn(),
    end: (data?: string) => { responseBody = data ?? "" },
  })
  const next = vi.fn()
  const req = makeRequest(method, url, rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined))
  await buildHandler()(req, res, next)
  return { res, next, json: () => JSON.parse(responseBody) as Record<string, unknown> }
}

function entry(id: string, fields: Partial<NotificationHistoryEntry> = {}): NotificationHistoryEntry {
  return {
    id,
    at: "2026-08-19T10:00:00.000Z",
    title: "Claude Code — proj",
    body: "Waiting for your input",
    kind: "turnComplete",
    sessionId: "s1",
    dirName: "-d",
    readBy: {},
    ...fields,
  }
}

async function readBy(): Promise<Record<string, Record<string, string>>> {
  return Object.fromEntries((await listNotifications()).map(({ id, readBy }) => [id, readBy]))
}

beforeEach(() => {
  resetNotificationHistoryForTests([
    entry("n-1", { readBy: { [LOCAL_READER]: "2026-08-19T11:00:00.000Z", u_bob: "2026-08-19T12:00:00.000Z" } }),
    entry("for-bob", { recipientId: "u_bob" }),
    entry("n-2", { sessionId: null, dirName: null, kind: "system" }),
  ])
})
afterEach(() => resetNotificationHistoryForTests())

describe("GET /api/notifications", () => {
  it("returns each notification as this reader sees it", async () => {
    const { res, json } = await request("GET", "/")
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      notifications: [
        {
          id: "n-1",
          at: "2026-08-19T10:00:00.000Z",
          title: "Claude Code — proj",
          body: "Waiting for your input",
          kind: "turnComplete",
          sessionId: "s1",
          dirName: "-d",
          readAt: "2026-08-19T11:00:00.000Z",
        },
        expect.objectContaining({ id: "n-2", readAt: null }),
      ],
    })
  })

  it("honors the limit parameter", async () => {
    const { json } = await request("GET", "/?limit=1")
    expect((json().notifications as unknown[]).length).toBe(1)
  })

  it("falls back to the default on a malformed limit", async () => {
    const { json } = await request("GET", "/?limit=banana")
    expect((json().notifications as unknown[]).length).toBe(2)
  })
})

describe("POST /api/notifications/read", () => {
  it("marks the given ids read for this reader", async () => {
    const { res, json } = await request("POST", "/read", { ids: ["n-2", "unknown"] })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ success: true })
    expect((await readBy())["n-2"]).toEqual({ [LOCAL_READER]: expect.any(String) })
  })

  it("marks everything this reader can see with { all: true }", async () => {
    const { res } = await request("POST", "/read", { all: true })
    expect(res.statusCode).toBe(200)
    const state = await readBy()
    expect(state["n-2"]).toHaveProperty(LOCAL_READER)
    expect(state["for-bob"]).toEqual({})
  })

  it("leaves a notification meant for someone else alone", async () => {
    await request("POST", "/read", { ids: ["for-bob"] })
    expect((await readBy())["for-bob"]).toEqual({})
  })

  it("rejects a body with neither ids nor all", async () => {
    const { res } = await request("POST", "/read", { ids: "n-1" })
    expect(res.statusCode).toBe(400)
  })

  it("rejects malformed JSON", async () => {
    const { res, json } = await request("POST", "/read", undefined, "{ not json")
    expect(res.statusCode).toBe(400)
    expect(json().error).toContain("Invalid JSON")
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
