// @vitest-environment node
import { Readable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  hostWide: true,
  auth: null as unknown,
  status: vi.fn(),
  update: vi.fn(),
  unlink: vi.fn(),
}))
vi.mock("../../slack", () => ({ slackService: () => ({ status: mocks.status, update: mocks.update, unlink: mocks.unlink }) }))
vi.mock("../../edition", () => ({ markDecided: vi.fn(), mayActHostWide: () => mocks.hostWide, editionModule: () => ({ auth: mocks.auth }) }))
vi.mock("../../sessionPaths", () => ({ findJsonlPath: async (id: string) => (id === "s1" ? "/p/s1.jsonl" : null) }))
vi.mock("../../sessionMetadata", () => ({ getSessionMeta: async () => ({ customTitle: "HonestCMS PM" }), sessionMetaTitle: (meta: { customTitle: string }) => meta.customTitle }))

import type { Middleware, UseFn } from "../../http"
import { registerSlackRoutes } from "../../routes/slack"
import { SlackLinkError } from "../../slack/service"
import { asIncomingMessage, asServerResponse } from "../http-fixtures"

function handler(): Middleware {
  let registered: Middleware | undefined
  const use: UseFn = (_path, middleware) => { registered = middleware }
  registerSlackRoutes(use)
  return registered!
}

function makeResponse() {
  const raw = { statusCode: 200, headersSent: false, setHeader: vi.fn(), body: "", end(chunk?: string) { this.body = chunk ?? "" } }
  return { res: asServerResponse(raw), raw, json: () => JSON.parse(raw.body) }
}

async function call(method: "GET" | "POST", body?: unknown, url = "/") {
  const { res, raw, json } = makeResponse()
  const next = vi.fn()
  const req = asIncomingMessage(Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, url, headers: {} as Record<string, string> }))
  await handler()(req, res, next)
  if (!next.mock.calls.length) await vi.waitFor(() => expect(raw.setHeader).toHaveBeenCalled())
  return { raw, next, json }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hostWide = true
  mocks.auth = null
  mocks.status.mockResolvedValue({ bots: [{ name: "odyssey", botUserId: "U0BOT", teamId: "T1" }], links: [{ sessionId: "s1", bot: "odyssey" }, { sessionId: "gone", bot: "other" }] })
})

describe("/api/slack", () => {
  it("lists bots and links with each session's title", async () => {
    const { raw, json } = await call("GET")
    expect(raw.statusCode).toBe(200)
    expect(json()).toEqual({
      available: true,
      bots: [{ name: "odyssey", botUserId: "U0BOT", teamId: "T1" }],
      links: [
        { sessionId: "s1", bot: "odyssey", title: "HonestCMS PM" },
        { sessionId: "gone", bot: "other", title: null },
      ],
    })
  })

  it("is for host administrators only", async () => {
    mocks.hostWide = false
    expect((await call("GET")).raw.statusCode).toBe(403)
    expect((await call("POST", { action: "unlink", sessionId: "s1" })).raw.statusCode).toBe(403)
    expect(mocks.unlink).not.toHaveBeenCalled()
  })

  it("says links are unavailable on an edition with accounts", async () => {
    mocks.auth = {}
    expect((await call("GET")).json().available).toBe(false)
  })

  it("updates a link's settings and unlinks", async () => {
    mocks.update.mockResolvedValue({ sessionId: "s1", autoPost: true })
    expect((await call("POST", { action: "update", sessionId: "s1", autoPost: true })).json()).toEqual({ link: { sessionId: "s1", autoPost: true } })
    expect(mocks.update).toHaveBeenCalledWith("s1", { autoPost: true, dailyCap: undefined })
    mocks.unlink.mockResolvedValue({ unlinked: true, droppedPending: 0 })
    expect((await call("POST", { action: "unlink", sessionId: "s1" })).json()).toEqual({ unlinked: true, droppedPending: 0 })
  })

  it("rejects malformed requests and reports link errors", async () => {
    expect((await call("POST", { action: "update", sessionId: "s1", autoPost: "yes" })).raw.statusCode).toBe(400)
    expect((await call("POST", { action: "update" })).raw.statusCode).toBe(400)
    expect((await call("POST", { action: "explode", sessionId: "s1" })).raw.statusCode).toBe(400)
    mocks.update.mockRejectedValue(new SlackLinkError("Session s9 is not linked to Slack"))
    const failed = await call("POST", { action: "update", sessionId: "s9", dailyCap: 5 })
    expect([failed.raw.statusCode, failed.json().error]).toEqual([400, "Session s9 is not linked to Slack"])
  })

  it("leaves other paths to later routes", async () => {
    expect((await call("GET", undefined, "/other")).next).toHaveBeenCalled()
  })
})
