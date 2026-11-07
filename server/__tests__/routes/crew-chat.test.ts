// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ context: vi.fn(), readContext: vi.fn(), read: vi.fn(), post: vi.fn(), listen: vi.fn(), authorize: vi.fn() }))
vi.mock("../../lib/crewChat", () => ({ crewChatContext: mocks.context, crewChatReadContext: mocks.readContext, readCrewChat: mocks.read, postCrewChat: mocks.post, setCrewChatListening: mocks.listen }))
vi.mock("../../edition", () => ({ authorizeSession: mocks.authorize }))
import { registerCrewChatRoutes } from "../../routes/crew-chat"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

async function call(method: string, url = "/lead", body?: unknown, headers: Record<string, string> = {}) {
  const handler = getRouteHandler(collectRoutes(registerCrewChatRoutes), "/api/crew-chat/")
  const { req, res, next, sendBody } = createMockReqRes(method, url, { headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const done = handler(req, res, next)
  sendBody()
  await done
  await vi.waitFor(() => expect(res.end.mock.calls.length + next.mock.calls.length).toBeGreaterThan(0))
  return { status: res._getStatus(), body: JSON.parse(res._getData() || "null"), headers: res._getHeaders() }
}
const members = [{ sessionId: "lead", name: "Lead", handle: "lead", listening: true, canInteract: true }]
const readContext = { rootId: "lead", members, membersVersion: "v1", canPost: true }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.authorize.mockResolvedValue({})
  mocks.context.mockResolvedValue({ rootId: "lead" })
  mocks.readContext.mockResolvedValue(readContext)
  mocks.read.mockResolvedValue({ ...readContext, messages: [], nextCursor: 4, hasMore: false })
  mocks.post.mockResolvedValue({ message: { text: "Hello" }, pending: [] })
  mocks.listen.mockResolvedValue({ listening: false })
})
it("reads pages from one crew context and checks both the member and lead session", async () => {
  expect((await call("GET", "/parser?after=2&limit=10")).status).toBe(200)
  expect(mocks.authorize.mock.calls.map(([, , session, level]) => [session.sessionId, level])).toEqual([["parser", "view"], ["lead", "view"]])
  expect(mocks.readContext).toHaveBeenCalledOnce()
  expect(mocks.context).not.toHaveBeenCalled()
  expect(mocks.read).toHaveBeenCalledWith("parser", { after: 2, before: undefined, limit: 10 }, expect.anything(), readContext)
})
it("leaves out members the client already holds, and answers an idle poll with a 304", async () => {
  const full = await call("GET", "/lead?after=4")
  expect(full.body).toEqual({ ...readContext, messages: [], nextCursor: 4, hasMore: false })
  const known = await call("GET", "/lead?after=4&knownMembers=v1")
  expect(known.body).not.toHaveProperty("members")
  expect(known.body.membersVersion).toBe("v1")
  expect(known.headers["Cache-Control"]).toBe("no-cache")
  const idle = await call("GET", "/lead?after=4&knownMembers=v1", undefined, { "if-none-match": known.headers.ETag! })
  expect(idle).toMatchObject({ status: 304, body: null })
  expect((await call("GET", "/lead?after=4&knownMembers=v0")).body.members).toEqual(members)
})
it("refuses a reader of a member whose lead it may not see", async () => {
  mocks.readContext.mockResolvedValue({ ...readContext, rootId: "lead" })
  mocks.authorize.mockImplementation(async (_req, res, { sessionId }) => { if (sessionId !== "lead") return {}; res.statusCode = 403; res.end("{}"); return null })
  expect((await call("GET", "/parser")).status).toBe(403)
  expect(mocks.read).not.toHaveBeenCalled()
})
it("posts trusted user messages and changes listening", async () => {
  expect((await call("POST", "/lead", { text: "Hello", commandId: "route-chat-001", mentions: ["parser"] })).status).toBe(200)
  expect(mocks.post).toHaveBeenCalledWith("lead", { text: "Hello", commandId: "route-chat-001", mentions: ["parser"], senderSessionId: undefined }, expect.anything(), { rootId: "lead" })
  expect((await call("PATCH", "/lead", { sessionId: "parser", listening: false })).status).toBe(200)
  expect(mocks.listen).toHaveBeenCalledWith("lead", "parser", false, expect.anything(), { rootId: "lead" })
  expect(mocks.readContext).not.toHaveBeenCalled()
})
it("rejects malformed posts and listening settings without performing writes", async () => {
  for (const body of [{ text: "hi" }, { text: "hi", commandId: 1 }, { text: "hi", commandId: "route-chat-001", mentions: [7] }, { text: "hi", commandId: "route-chat-001", senderSessionId: 1 }]) expect((await call("POST", "/lead", body)).status).toBe(400)
  expect((await call("PATCH", "/lead", { sessionId: "parser", listening: "false" })).status).toBe(400)
  expect(mocks.post).not.toHaveBeenCalled()
  expect(mocks.listen).not.toHaveBeenCalled()
})
