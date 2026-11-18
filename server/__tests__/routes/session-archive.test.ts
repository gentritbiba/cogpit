// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  setSessionsArchived: vi.fn(),
  findJsonlPath: vi.fn(),
  setArchiveMark: vi.fn(),
  storeForPath: vi.fn(),
}))

vi.mock("../../lib/sessionArchive", () => ({ setSessionsArchived: mocks.setSessionsArchived }))
vi.mock("../../sessionPaths", () => ({ findJsonlPath: mocks.findJsonlPath }))
vi.mock("../../agents", () => ({ storeForPath: mocks.storeForPath }))
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
    mocks.findJsonlPath.mockReset()
    mocks.findJsonlPath.mockImplementation(async (id: string) => `/projects/-work/${id}.jsonl`)
    mocks.setArchiveMark.mockReset()
    mocks.setArchiveMark.mockResolvedValue(undefined)
    mocks.storeForPath.mockReset()
    mocks.storeForPath.mockReturnValue({ setArchiveMark: mocks.setArchiveMark })
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
    expect(mocks.setSessionsArchived).toHaveBeenCalledWith(["a", "b"], true, { byUser: true })
    expect(body).toEqual({ sessionIds: ["a", "b"], archived: true, changed: ["a", "b"] })
  })

  it("restores sessions", async () => {
    const { body } = await post({ sessionIds: ["a"], archived: false })
    expect(body).toEqual({ sessionIds: ["a"], archived: false, changed: ["a"] })
  })

  it("repeats the choice in the agent CLI's own archive where the session's store keeps one", async () => {
    mocks.storeForPath.mockImplementation((filePath: string) => filePath.includes("/b.") ? {} : { setArchiveMark: mocks.setArchiveMark })

    await post({ sessionIds: ["a", "b"], archived: true })
    await vi.waitFor(() => expect(mocks.setArchiveMark).toHaveBeenCalledTimes(1))
    expect(mocks.setArchiveMark).toHaveBeenCalledWith("/projects/-work/a.jsonl", true)

    await post({ sessionIds: ["a"], archived: false })
    await vi.waitFor(() => expect(mocks.setArchiveMark).toHaveBeenLastCalledWith("/projects/-work/a.jsonl", false))
  })

  it("answers without waiting for the agent's archive, and only logs when it refuses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    let refuse: (error: Error) => void = () => {}
    mocks.setArchiveMark.mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject }))

    const { status } = await post({ sessionIds: ["a"], archived: true })
    expect(status).toBe(200)

    await vi.waitFor(() => expect(mocks.setArchiveMark).toHaveBeenCalled())
    refuse(new Error("Session a not found in any project directory"))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("[archive] a was not archived"), expect.any(Error)))
    warn.mockRestore()
  })

  it("skips a session whose transcript is gone", async () => {
    mocks.findJsonlPath.mockResolvedValue(null)
    const { status } = await post({ sessionIds: ["a"], archived: true })
    expect(status).toBe(200)
    await vi.waitFor(() => expect(mocks.findJsonlPath).toHaveBeenCalledWith("a"))
    expect(mocks.storeForPath).not.toHaveBeenCalled()
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
