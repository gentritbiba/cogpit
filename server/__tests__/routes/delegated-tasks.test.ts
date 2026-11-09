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

async function get(url: string, headers: Record<string, string> = {}) {
  const handler = getRouteHandler(collectRoutes(registerDelegatedTaskRoutes), "/api/delegated-tasks")
  const { req, res, next } = createMockReqRes("GET", url, { headers })
  await handler(req, res, next)
  const data = res._getData()
  return { status: res._getStatus(), headers: res._getHeaders(), body: data ? JSON.parse(data) : null }
}

function seed() {
  const store = orchestrationStore()
  const put = (sourceId: string, childSessionId: string, parentSessionId = "parent") => store.putTask("local", { sourceId, parentSessionId, childSessionId })
  const running = put("running", "a")
  const done = put("done", "b")
  store.updateTask("local", done.id, { state: "completed", result: { reply: "x".repeat(5000) } })
  const read = put("read", "c")
  store.updateTask("local", read.id, { state: "completed", acknowledgedAt: 1 })
  const cancelled = put("cancelled", "d")
  store.updateTask("local", cancelled.id, { state: "cancelled" })
  const superseded = put("superseded", "a")
  store.updateTask("local", superseded.id, { acknowledgedAt: 2 })
  put("elsewhere", "e", "other")
  return { running, done }
}

beforeEach(() => {
  mocks.resumeDelegations.mockClear()
  mocks.hidden.clear()
})

describe("GET /api/delegated-tasks?view=counts", () => {
  it("counts the parent's tasks without their results, with an ETag the next poll revalidates", async () => {
    seed()
    const first = await get("/?sessionId=parent&view=counts")
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ counts: { total: 5, running: 2, unread: 2, unreadRunning: 1 } })
    expect(first.headers.ETag).toMatch(/^W\/".+"$/)
    expect(first.headers["Cache-Control"]).toBe("no-cache")

    const unchanged = await get("/?sessionId=parent&view=counts", { "if-none-match": first.headers.ETag! })
    expect(unchanged.status).toBe(304)
    expect(unchanged.body).toBeNull()
    expect(unchanged.headers.ETag).toBe(first.headers.ETag)
  })

  it("answers with new counts once a task is read or finishes", async () => {
    const { running, done } = seed()
    const before = await get("/?sessionId=parent&view=counts")
    orchestrationStore().updateTask("local", done.id, { acknowledgedAt: 3 })
    const acknowledged = await get("/?sessionId=parent&view=counts", { "if-none-match": before.headers.ETag! })
    expect(acknowledged.status).toBe(200)
    expect(acknowledged.body.counts).toEqual({ total: 5, running: 2, unread: 1, unreadRunning: 1 })
    orchestrationStore().updateTask("local", running.id, { state: "completed" })
    const finished = await get("/?sessionId=parent&view=counts", { "if-none-match": acknowledged.headers.ETag! })
    expect(finished.status).toBe(200)
    expect(finished.body.counts).toEqual({ total: 5, running: 1, unread: 1, unreadRunning: 0 })
  })

  it("leaves out tasks whose child the caller may not see", async () => {
    seed()
    mocks.hidden.add("a")
    expect((await get("/?sessionId=parent&view=counts")).body.counts).toEqual({ total: 3, running: 0, unread: 1, unreadRunning: 0 })
  })

  it("re-arms result delivery only for a parent with unread tasks", async () => {
    seed()
    await get("/?sessionId=parent&view=counts")
    expect(mocks.resumeDelegations).toHaveBeenCalledWith(expect.anything(), "parent")
    mocks.resumeDelegations.mockClear()
    await get("/?sessionId=nobody&view=counts")
    const read = orchestrationStore().putTask("local", { sourceId: "all-read", parentSessionId: "reader", childSessionId: "z" })
    orchestrationStore().updateTask("local", read.id, { state: "completed", acknowledgedAt: 1 })
    expect((await get("/?sessionId=reader&view=counts")).body.counts).toEqual({ total: 1, running: 0, unread: 0, unreadRunning: 0 })
    expect(mocks.resumeDelegations).not.toHaveBeenCalled()
  })
})

describe("GET /api/delegated-tasks", () => {
  it("still lists every visible task with its result", async () => {
    const { done } = seed()
    mocks.hidden.add("c")
    const { status, body, headers } = await get("/?sessionId=parent")
    expect(status).toBe(200)
    expect(headers.ETag).toBeUndefined()
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
