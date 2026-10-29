// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
import { registerSessionCommandRoutes } from "../../routes/session-commands"
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), context: vi.fn(), status: vi.fn(), enable: vi.fn(), cancel: vi.fn(), reauthorize: vi.fn(),
}))
vi.mock("../../edition", async (original) => ({ ...await original<object>(), authorizeSession: mocks.authorize }))
vi.mock("../../lib/sessionQueue", async (original) => ({ ...await original<object>(), queueContext: mocks.context }))
vi.mock("../../lib/allowanceRecovery", () => ({
  initializeAllowanceRecovery: () => {}, recoveryStatus: mocks.status, optInRecovery: mocks.enable, cancelRecovery: mocks.cancel, reauthorizeRecovery: mocks.reauthorize,
}))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.authorize.mockResolvedValue({ sessionId: "session" })
  mocks.context.mockResolvedValue({ conversation: { binding: { sessionId: "session" } } })
  for (const service of [mocks.status, mocks.enable, mocks.cancel, mocks.reauthorize]) service.mockResolvedValue({ run: null, offer: null })
})
async function request(method: string, body?: unknown) {
  const handler = getRouteHandler(collectRoutes(registerSessionCommandRoutes), "/api/session-commands")
  const fixture = createMockReqRes(method, "/?recovery=1&sessionId=session", { body: JSON.stringify(body) })
  const done = handler(fixture.req, fixture.res, fixture.next)
  fixture.sendBody(); await done
  await vi.waitFor(() => expect(fixture.res.end).toHaveBeenCalled())
  return fixture
}
it("authorizes a status read as view without issuing authority", async () => {
  const result = await request("GET")
  expect(result.res._getStatus()).toBe(200)
  expect(mocks.authorize).toHaveBeenCalledWith(result.req, result.res, { sessionId: "session" }, "view")
  expect(mocks.status).toHaveBeenCalledWith(result.req, "session")
  expect(mocks.enable).not.toHaveBeenCalled()
})
it.each(["enable", "cancel", "reauthorize"])("requires fresh interact access before %s", async (action) => {
  const result = await request("POST", { sessionId: "session", action, offerId: "server-offer" })
  expect(result.res._getStatus()).toBe(200)
  expect(mocks.authorize).toHaveBeenCalledWith(result.req, result.res, { sessionId: "session" }, "interact")
})
it("refuses a mutation after access is revoked", async () => {
  mocks.authorize.mockImplementation(async (_req, res) => { res.statusCode = 403; res.end("denied"); return null })
  const result = await request("POST", { sessionId: "session", action: "enable", offerId: "server-offer" })
  expect(result.res._getStatus()).toBe(403)
  expect(mocks.enable).not.toHaveBeenCalled()
})
it("rechecks the current bound session too", async () => {
  mocks.context.mockResolvedValue({ conversation: { binding: { sessionId: "moved-session" } } })
  await request("POST", { sessionId: "session", action: "cancel" })
  expect(mocks.authorize.mock.calls.map((call) => call[2].sessionId)).toEqual(["session", "moved-session"])
})
it("rejects unknown actions", async () => {
  const result = await request("POST", { sessionId: "session", action: "retry-everything" })
  expect(result.res._getStatus()).toBe(400)
  expect(mocks.enable).not.toHaveBeenCalled()
})
