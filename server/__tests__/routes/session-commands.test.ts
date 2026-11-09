// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { __resetEditionForTest } from "../../edition"
import { closeCommandDispatcher, commandDispatcher } from "../../lib/durableSend"
import type { DispatcherLease } from "../../orchestration/store"
import { registerSessionCommandRoutes } from "../../routes/session-commands"

vi.mock("../../agents/runtimes", async (original) => ({
  ...await original<typeof import("../../agents/runtimes")>(),
  resolveSessionAgent: async () => ({ kind: "claude", instanceId: "default", filePath: null }),
  runtimeFor: () => ({ descriptor: descriptorFor("claude"), send: vi.fn() }),
}))
vi.mock("../../sessionPaths", () => ({ findJsonlPath: async () => null }))
vi.mock("../../sessionHosts/localHost", () => ({ localHost: { address: async () => ({ dirName: "project", fileName: "session.jsonl" }) } }))

const SESSION = "00000000-0000-4000-8000-000000000001"
const handler = getRouteHandler(collectRoutes(registerSessionCommandRoutes), "/api/session-commands")
let lease: DispatcherLease
let conversationId: string

beforeEach(() => {
  __resetEditionForTest()
  const dispatcher = commandDispatcher()
  dispatcher.close()
  conversationId = dispatcher.store.ensureConversation({ hostId: "local", agent: "claude", instanceId: "default", sessionId: SESSION, nativeSessionId: SESSION }).id
  lease = dispatcher.store.acquire("test-owner", 60_000)!
})
afterEach(() => { closeCommandDispatcher(); __resetEditionForTest() })

function complete(id: string): void {
  const { store } = commandDispatcher()
  store.admit("local", id, conversationId, { message: `done ${id}` })
  store.finish(store.claim("local", id, lease)!, lease, "completed")
}

async function get(query: string, headers: Record<string, string> = {}) {
  const fixture = createMockReqRes("GET", `/?sessionId=${SESSION}${query}`, { headers })
  await handler(fixture.req, fixture.res, fixture.next)
  const raw = fixture.res as unknown as { _getStatus(): number; _getData(): string; _getHeaders(): Record<string, string> }
  return { status: raw._getStatus(), text: raw._getData(), body: raw._getData() ? JSON.parse(raw._getData()) : null, etag: raw._getHeaders().ETag }
}

describe("GET /api/session-commands", () => {
  it("returns only commands that are still open, plus the ones asked for by id", async () => {
    const { store } = commandDispatcher()
    complete("finished-1")
    complete("finished-2")
    store.admit("local", "withdrawn", conversationId, { message: "never mind" })
    store.cancel("local", "withdrawn")
    store.admit("local", "rejected", conversationId, { message: "broke" })
    store.finish(store.claim("local", "rejected", lease)!, lease, "failed", { error: "boom" })
    store.admit("local", "waiting-1", conversationId, { message: "next" })

    expect((await get("")).body.commands.map((command: { id: string }) => command.id)).toEqual(["rejected", "waiting-1"])
    const asked = await get("&commandId=finished-2&commandId=withdrawn&commandId=elsewhere")
    expect(asked.body.commands.map((command: { id: string; state: string }) => [command.id, command.state])).toEqual([["finished-2", "completed"], ["withdrawn", "cancelled"], ["rejected", "failed"], ["waiting-1", "queued"]])
  })

  it("adds replay only when the request carries a cursor, as older clients send", async () => {
    complete("finished")
    const current = await get("")
    expect(current.body).not.toHaveProperty("replay")
    expect(current.body).toMatchObject({ conversation: { id: conversationId }, currentAddress: { dirName: "project" }, pendingTransition: null, commands: [] })
    const legacy = await get("&after=0")
    expect(legacy.body.replay).toMatchObject({ reset: false, hasMore: false })
    expect(legacy.body.replay.events.length).toBeGreaterThan(0)
    expect(legacy.body.replay.cursor).toBeGreaterThan(0)
  })

  it("lists finished commands too for an older client, which waits to see its receipt finish (review #3)", async () => {
    complete("finished")
    commandDispatcher().store.admit("local", "waiting-1", conversationId, { message: "next" })
    const legacy = await get("&after=0")
    expect(legacy.body.commands.map((command: { id: string; state: string }) => [command.id, command.state])).toEqual([["finished", "completed"], ["waiting-1", "queued"]])
    expect((await get("")).body.commands.map((command: { id: string }) => command.id)).toEqual(["waiting-1"])
  })

  it("tags the body and answers 304 while it is unchanged", async () => {
    const first = await get("")
    expect(first.etag).toMatch(/^W\/"[\w-]+"$/)
    const same = await get("", { "if-none-match": first.etag! })
    expect(same).toMatchObject({ status: 304, text: "", etag: first.etag })
    expect((await get("", { "if-none-match": `"other", ${first.etag!.slice(2)}` })).status).toBe(304)

    commandDispatcher().store.admit("local", "new-message", conversationId, { message: "hello" })
    const changed = await get("", { "if-none-match": first.etag! })
    expect(changed.status).toBe(200)
    expect(changed.etag).not.toBe(first.etag)
    expect(changed.body.commands.map((command: { id: string }) => command.id)).toEqual(["new-message"])
  })

  it("keeps the response small for a conversation with many finished commands", async () => {
    for (let index = 0; index < 20; index++) complete(`finished-${index}`)
    commandDispatcher().store.admit("local", "waiting-1", conversationId, { message: "next" })
    const { text, body } = await get("")
    expect(body.commands).toHaveLength(1)
    expect(text.length).toBeLessThan(2_000)
  })
})

describe("POST /api/session-commands", () => {
  it("returns the open commands and the one the action touched", async () => {
    const { store } = commandDispatcher()
    complete("finished")
    store.admit("local", "first-message", conversationId, { message: "one" })
    store.admit("local", "second-message", conversationId, { message: "two" })
    const fixture = createMockReqRes("POST", "/", { body: JSON.stringify({ sessionId: SESSION, action: "cancel", commandId: "first-message" }) })
    void handler(fixture.req, fixture.res, fixture.next)
    fixture.sendBody()
    const raw = fixture.res as unknown as { _getStatus(): number; _getData(): string }
    await vi.waitFor(() => expect(raw._getData()).not.toBe(""))
    expect(raw._getStatus()).toBe(200)
    expect(JSON.parse(raw._getData()).commands.map((command: { id: string; state: string }) => [command.id, command.state])).toEqual([["first-message", "cancelled"], ["second-message", "queued"]])
  })
})
