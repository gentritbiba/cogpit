// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ resumeDelegations: vi.fn(), hidden: new Set<string>() }))
vi.mock("../../lib/delegationAuthority", () => ({
  delegationAuthority: () => ({ authorize: async (id: string) => !mocks.hidden.has(id), host: async () => { throw new Error("unused") } }),
  resumeDelegations: mocks.resumeDelegations,
}))

import { registerDelegatedTaskRoutes } from "../../routes/delegated-tasks"
import { orchestrationStore } from "../../orchestration/storage"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

async function get(url: string) {
  const handler = getRouteHandler(collectRoutes(registerDelegatedTaskRoutes), "/api/delegated-tasks")
  const { req, res, next } = createMockReqRes("GET", url)
  await handler(req, res, next)
  return { status: res._getStatus(), body: JSON.parse(res._getData()) }
}

function seed() {
  const store = orchestrationStore()
  const put = (sourceId: string, childSessionId: string, parentSessionId = "parent") => store.putTask("local", { sourceId, parentSessionId, childSessionId })
  put("running", "a")
  const done = put("done", "b")
  store.updateTask("local", done.id, { state: "completed", result: { reply: "x".repeat(5000) } })
  const read = put("read", "c")
  store.updateTask("local", read.id, { state: "completed", acknowledgedAt: 1 })
  const cancelled = put("cancelled", "d")
  store.updateTask("local", cancelled.id, { state: "cancelled" })
  const superseded = put("superseded", "a")
  store.updateTask("local", superseded.id, { acknowledgedAt: 2 })
  put("elsewhere", "e", "other")
  return { done }
}

beforeEach(() => {
  mocks.resumeDelegations.mockClear()
  mocks.hidden.clear()
})

describe("GET /api/delegated-tasks", () => {
  it("lists every visible task with its result", async () => {
    const { done } = seed()
    mocks.hidden.add("c")
    const { status, body } = await get("/?sessionId=parent")
    expect(status).toBe(200)
    expect(body.tasks).toHaveLength(4)
    expect(body.tasks.find((task: { id: string }) => task.id === done.id).result).toEqual({ reply: "x".repeat(5000) })
  })

  it("re-arms result delivery only for a parent with unread tasks", async () => {
    seed()
    await get("/?sessionId=parent")
    expect(mocks.resumeDelegations).toHaveBeenCalledWith(expect.anything(), "parent")
    mocks.resumeDelegations.mockClear()
    await get("/?sessionId=nobody")
    const read = orchestrationStore().putTask("local", { sourceId: "all-read", parentSessionId: "reader", childSessionId: "z" })
    orchestrationStore().updateTask("local", read.id, { state: "completed", acknowledgedAt: 1 })
    expect((await get("/?sessionId=reader")).body.tasks).toHaveLength(1)
    expect(mocks.resumeDelegations).not.toHaveBeenCalled()
  })
})
