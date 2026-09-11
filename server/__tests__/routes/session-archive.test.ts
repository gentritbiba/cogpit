// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ setSessionsArchived: vi.fn() }))

vi.mock("../../lib/sessionArchive", () => ({ setSessionsArchived: mocks.setSessionsArchived }))
vi.mock("../../helpers", () => ({
  sendJson: (
    res: { statusCode: number; setHeader: (n: string, v: string) => void; end: (v?: string) => void },
    status: number,
    data: unknown,
  ) => {
    res.statusCode = status
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(data))
  },
}))

import { registerSessionArchiveRoutes } from "../../routes/session-archive"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

async function post(body: unknown) {
  const handler = getRouteHandler(collectRoutes(registerSessionArchiveRoutes), "/api/archive-sessions")
  const { req, res, next, sendBody } = createMockReqRes("POST", "/", { body: JSON.stringify(body) })
  const done = handler(req, res, next)
  sendBody()
  await done
  return { status: res._getStatus(), body: JSON.parse(res._getData() || "null"), next }
}

describe("POST /api/archive-sessions", () => {
  beforeEach(() => {
    mocks.setSessionsArchived.mockReset()
    mocks.setSessionsArchived.mockImplementation(async (ids: string[]) => ids)
  })

  it("ignores other methods", async () => {
    const handler = getRouteHandler(collectRoutes(registerSessionArchiveRoutes), "/api/archive-sessions")
    const { req, res, next } = createMockReqRes("GET", "/")
    await handler(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it("archives the listed sessions once each", async () => {
    const { status, body } = await post({ sessionIds: ["a", "b", "a"], archived: true })

    expect(status).toBe(200)
    expect(mocks.setSessionsArchived).toHaveBeenCalledWith(["a", "b"], true)
    expect(body).toEqual({ sessionIds: ["a", "b"], archived: true, changed: ["a", "b"] })
  })

  it("restores sessions", async () => {
    const { body } = await post({ sessionIds: ["a"], archived: false })
    expect(body).toEqual({ sessionIds: ["a"], archived: false, changed: ["a"] })
  })

  it("reports a failed write instead of pretending it landed", async () => {
    mocks.setSessionsArchived.mockRejectedValueOnce(new Error("EACCES"))
    const { status } = await post({ sessionIds: ["a"], archived: true })
    expect(status).toBe(500)
  })

  it.each([
    ["missing archived flag", { sessionIds: ["a"] }],
    ["non-boolean archived", { sessionIds: ["a"], archived: "yes" }],
    ["empty ids", { sessionIds: [], archived: true }],
    ["blank id", { sessionIds: [""], archived: true }],
    ["non-string id", { sessionIds: [42], archived: true }],
    ["array body", [1]],
  ])("rejects %s", async (_label, body) => {
    const { status } = await post(body)
    expect(status).toBe(400)
    expect(mocks.setSessionsArchived).not.toHaveBeenCalled()
  })
})
