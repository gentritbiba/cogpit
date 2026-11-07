// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IncomingMessage } from "node:http"
import { OrchestrationStore } from "../../orchestration/store"
import type { SessionAccessLevel } from "../../../shared/contracts/sessionAccess"

const mocks = vi.hoisted(() => ({
  store: null as unknown as OrchestrationStore,
  parents: new Map([
    ["parser", { parentSessionId: "lead", createdAt: 1, name: "Parser" }],
    ["reviewer", { parentSessionId: "parser", createdAt: 2, name: "Reviewer" }],
    ["idle", { parentSessionId: "lead", createdAt: 3, name: "Idle" }],
    ["other-child", { parentSessionId: "other", createdAt: 4 }],
  ]),
  access: vi.fn<(req: IncomingMessage, id: string) => Promise<SessionAccessLevel | null>>(),
  state: vi.fn(), send: vi.fn(), host: vi.fn(),
  revision: 1,
  auth: null as unknown,
}))
vi.mock("../../orchestration/storage", () => ({ orchestrationStore: () => mocks.store, closeOrchestrationStore: vi.fn(), beforeOrchestrationClose: vi.fn() }))
vi.mock("../../lib/sessionOrigins", () => ({ sessionParents: async () => mocks.parents, sessionOriginsRevision: () => mocks.revision }))
vi.mock("../../lib/durableSend", () => ({ commandScope: () => "local", refreshExecutionRequest: (req: IncomingMessage) => req }))
vi.mock("../../edition", () => ({ accessLevelOf: mocks.access, editionModule: () => ({ auth: mocks.auth }), getRequestPrincipal: () => null }))
vi.mock("../../sessionHosts", () => ({ hostForSession: mocks.host }))
vi.mock("../../routes/hello", () => ({ getDeviceName: () => "coordinator-box" }))

import { closeCrewChatMonitor, crewChatReadContext, deliverCrewChat, postCrewChat, readCrewChat, resumeLocalCrewChat, setCrewChatListening, watchCrewChat } from "../../lib/crewChat"
const req = {} as IncomingMessage
const post = (text: string, commandId = "chat-message-001", senderSessionId = "parser", mentions?: string[]) => postCrewChat("parser", { text, commandId, senderSessionId, mentions }, req)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.store = new OrchestrationStore(":memory:")
  mocks.revision++
  mocks.auth = null
  mocks.access.mockResolvedValue("own")
  mocks.state.mockImplementation(async (id: string) => ({ outcome: id === "idle" ? "completed" : "running", running: id !== "idle", live: id !== "idle", activeNotifications: true }))
  mocks.send.mockResolvedValue({ delivery: "queued" })
  mocks.host.mockResolvedValue({ has: async () => true, state: mocks.state, send: mocks.send, remote: false })
})
afterEach(() => { closeCrewChatMonitor(); mocks.store.close(); vi.useRealTimers() })

describe("crew chat", () => {
  it("shares one history across nested members and keeps unrelated crews separate", async () => {
    await post("Parser finding")
    const page = await readCrewChat("reviewer", {}, req)
    expect(page.rootId).toBe("lead")
    expect(page.messages[0]).toMatchObject({ author: { kind: "agent", name: "Parser", sessionId: "parser" }, text: "Parser finding" })
    expect(page.members.map((member) => member.handle)).toEqual(["lead", "parser", "reviewer", "idle"])
    expect((await readCrewChat("other", {}, req)).messages).toEqual([])
  })

  it("notifies working listeners without including the message or waking idle members", async () => {
    await setCrewChatListening("lead", "reviewer", false, req)
    await post("Private full text should only be fetched")
    expect(mocks.send).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledWith("lead", expect.stringContaining("new message is available"), expect.objectContaining({ onlyWhileRunning: true, notification: true, intent: "steer" }))
    expect(mocks.send.mock.calls[0]![1]).not.toContain("Private full text")
    expect(mocks.send.mock.calls[0]![1]).toContain("No reply or action is required")
  })

  it("sends the full text to tagged muted and idle members", async () => {
    await setCrewChatListening("lead", "reviewer", false, req)
    await post("@reviewer @idle Check the parser finding")
    const review = mocks.send.mock.calls.find(([id]) => id === "reviewer")!
    expect(review[1]).toContain("@reviewer @idle Check the parser finding")
    expect(review[2]).not.toHaveProperty("onlyWhileRunning")
    expect(mocks.send).toHaveBeenCalledWith("idle", expect.stringContaining("You were tagged"), expect.objectContaining({ intent: "steer" }))
    expect(mocks.send.mock.calls.some(([id]) => id === "parser")).toBe(false)
  })

  it("queues a full mention for a provider that cannot take active notifications", async () => {
    mocks.state.mockResolvedValue({ outcome: "running", running: true, activeNotifications: false })
    await post("@reviewer Check this")
    expect(mocks.send).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledWith("reviewer", expect.any(String), expect.objectContaining({ intent: "queue" }))
  })

  it("never leaves a remote member's message in the device's queue, keeping it here until the device takes it", async () => {
    let busy = true
    mocks.state.mockResolvedValue({ outcome: "running", running: true, activeNotifications: false })
    mocks.host.mockResolvedValue({ has: async () => true, state: mocks.state, send: mocks.send, remote: true })
    mocks.send.mockImplementation(async () => ({ delivery: busy ? "busy" : "enqueued" }))
    const first = await post("@reviewer Check this")
    expect(first.pending).toEqual([{ sessionId: "reviewer", error: "Crew member could not accept this message" }])
    for (const [, , options] of mocks.send.mock.calls) {
      expect(options).not.toHaveProperty("commandId")
      expect(options).not.toHaveProperty("leadSessionId")
    }
    busy = false
    await deliverCrewChat("lead", req)
    expect(mocks.store.chatDeliveries("lead", "local")).toEqual([])
  })

  it("deduplicates posts and retries failed deliveries with the same command ID", async () => {
    mocks.send.mockRejectedValue(new Error("offline"))
    const first = await post("Retryable finding")
    expect(first.pending).toHaveLength(2)
    const ids = mocks.send.mock.calls.map(([, , options]) => options.commandId)
    mocks.send.mockResolvedValue({ delivery: "queued" })
    expect((await post("Retryable finding")).message).toEqual(first.message)
    expect(mocks.send.mock.calls.slice(2).map(([, , options]) => options.commandId)).toEqual(ids)
    expect(mocks.store.chatMessages("lead", { limit: 100 })).toHaveLength(1)
    await expect(post("Different finding")).rejects.toMatchObject({ status: 409 })
  })

  it("retries pending deliveries in the background without another read or post", async () => {
    vi.useFakeTimers()
    mocks.send.mockRejectedValue(new Error("temporarily offline"))
    const first = await post("@reviewer Retry this finding")
    expect(first.pending).toHaveLength(2)
    mocks.send.mockClear().mockResolvedValue({ delivery: "queued" })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.send).toHaveBeenCalledTimes(2)
    expect(mocks.store.chatDeliveries("lead", "local")).toEqual([])
  })

  it("answers a post without waiting on a member that is slow to accept, and keeps delivering", async () => {
    vi.useFakeTimers()
    let release!: () => void
    mocks.send.mockImplementation(async (id: string) => (id === "lead" ? new Promise((resolve) => { release = () => resolve({ delivery: "queued" }) }) : { delivery: "queued" }))
    const posted = post("Ready for review")
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await posted).pending).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "lead" })]))
    release()
    await vi.waitFor(() => expect(mocks.store.chatDeliveries("lead", "local")).toEqual([]))
  })

  it("drains a new post that arrives while another post is being delivered", async () => {
    let release!: () => void
    mocks.send.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ delivery: "queued" }) }))
    const first = post("First", "concurrent-chat-1")
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce())
    const second = post("Second", "concurrent-chat-2")
    await vi.waitFor(() => expect(mocks.store.chatMessages("lead", { limit: 100 })).toHaveLength(2))
    release()
    await Promise.all([first, second])
    expect(mocks.store.chatDeliveries("lead", "local")).toEqual([])
    expect(mocks.send).toHaveBeenCalledTimes(4)
  })

  it("tracks independent read cursors, pages forward, and replays a lost fetch response", async () => {
    for (let n = 1; n <= 3; n++) await post(`Finding ${n}`, `read-message-${n}`)
    const first = await readCrewChat("lead", { readerSessionId: "reviewer", limit: 2, fetchId: "fetch-first-001" }, req)
    expect(first.messages.map((message) => message.text)).toEqual(["Finding 1", "Finding 2"])
    expect(first.hasMore).toBe(true)
    expect((await readCrewChat("lead", { readerSessionId: "reviewer", limit: 2, fetchId: "fetch-first-001" }, req)).messages).toEqual(first.messages)
    expect((await readCrewChat("lead", { readerSessionId: "reviewer" }, req)).messages.map((message) => message.text)).toEqual(["Finding 3"])
    expect((await readCrewChat("lead", { readerSessionId: "parser" }, req)).messages).toHaveLength(3)
    expect((await readCrewChat("lead", { readerSessionId: "reviewer", after: 0 }, req)).messages).toHaveLength(3)
    expect((await readCrewChat("lead", { readerSessionId: "reviewer" }, req)).messages).toEqual([])
  })

  it("pages the latest history backward without moving agent read positions", async () => {
    for (let n = 1; n <= 3; n++) await post(`Finding ${n}`, `page-message-${n}`)
    const latest = await readCrewChat("lead", { limit: 2 }, req)
    expect(latest.messages.map((message) => message.text)).toEqual(["Finding 2", "Finding 3"])
    expect(latest.hasMore).toBe(true)
    expect((await readCrewChat("lead", { before: latest.messages[0]!.sequence }, req)).messages.map((message) => message.text)).toEqual(["Finding 1"])
    expect(mocks.store.chatListener("lead", "parser").cursor).toBe(0)
  })

  it("requires lead access, rejects outside mentions and forged senders, and validates pages", async () => {
    await expect(post("Hi", "invalid-tag-001", "parser", ["other-child"])).rejects.toMatchObject({ status: 400 })
    await expect(post("Hi", "invalid-sender-001", "other-child")).rejects.toMatchObject({ status: 403 })
    await expect(readCrewChat("lead", { after: -1 }, req)).rejects.toMatchObject({ status: 400 })
    await expect(readCrewChat("lead", { limit: 101 }, req)).rejects.toMatchObject({ status: 400 })
    mocks.access.mockImplementation(async (_, id) => id === "lead" ? null : "own")
    await expect(readCrewChat("parser", {}, req)).rejects.toMatchObject({ status: 403 })
  })

  it("rechecks recipient access after awaiting its state", async () => {
    let reviewerAllowed = true
    mocks.access.mockImplementation(async (_, id) => id === "reviewer" && !reviewerAllowed ? null : "own")
    mocks.state.mockImplementation(async (id) => { if (id === "reviewer") reviewerAllowed = false; return { outcome: "running", running: true, activeNotifications: true } })
    await post("@reviewer Private finding")
    expect(mocks.send.mock.calls.some(([id]) => id === "reviewer")).toBe(false)
  })

  it("includes the coordinator device when notifying a remote member", async () => {
    mocks.host.mockResolvedValue({ has: async () => true, state: mocks.state, send: mocks.send, remote: true })
    await post("Remote finding")
    expect(mocks.send.mock.calls[0]![1]).toContain("--device 'coordinator-box'")
  })

  it("routes a tagged remote member's reply back into the same shared chat", async () => {
    mocks.host.mockResolvedValue({ has: async () => true, state: mocks.state, send: mocks.send, remote: true })
    await post("@reviewer Share your review here")
    const review = mocks.send.mock.calls.find(([id]) => id === "reviewer")!
    expect(review[1]).toContain('Reply in the shared chat if useful: cogpit-session chat post "YOUR_MESSAGE" --crew \'lead\' --device \'coordinator-box\'')
  })

  it("does not retry notices to a member who has since muted the chat", async () => {
    mocks.send.mockRejectedValue(new Error("offline"))
    await post("Finding")
    mocks.send.mockClear().mockResolvedValue({ delivery: "queued" })
    await setCrewChatListening("lead", "reviewer", false, req)
    await deliverCrewChat("lead", req)
    expect(mocks.send.mock.calls.some(([id]) => id === "reviewer")).toBe(false)
  })

  it("reuses the crew between reads until its lineage changes, and reads listening every time", async () => {
    const first = await crewChatReadContext("parser", req)
    const checks = mocks.access.mock.calls.length
    expect(await crewChatReadContext("parser", req)).toEqual(first)
    expect(mocks.access.mock.calls.length).toBe(checks)

    await setCrewChatListening("lead", "idle", false, req)
    const muted = await crewChatReadContext("parser", req)
    expect(muted.members.find((member) => member.sessionId === "idle")?.listening).toBe(false)
    expect(muted.membersVersion).not.toBe(first.membersVersion)

    mocks.parents.set("late", { parentSessionId: "lead", createdAt: 5, name: "Late" })
    try {
      expect((await crewChatReadContext("parser", req)).members.map((member) => member.handle)).not.toContain("late")
      mocks.revision++
      expect((await crewChatReadContext("parser", req)).members.map((member) => member.handle)).toContain("late")
    } finally { mocks.parents.delete("late") }
  })

  it("rechecks the caller's access to a crew's members after a few seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    expect((await crewChatReadContext("parser", req)).members.find((member) => member.sessionId === "idle")?.canInteract).toBe(true)
    mocks.access.mockImplementation(async (_, id) => (id === "idle" ? "view" : "own"))
    expect((await crewChatReadContext("parser", req)).members.find((member) => member.sessionId === "idle")?.canInteract).toBe(true)
    vi.setSystemTime(Date.now() + 5_000)
    expect((await crewChatReadContext("parser", req)).members.find((member) => member.sessionId === "idle")?.canInteract).toBe(false)
  })

  it("delivers from a read only while the crew has messages on their way", async () => {
    await readCrewChat("lead", {}, req)
    expect(mocks.state).not.toHaveBeenCalled()
    mocks.send.mockRejectedValueOnce(new Error("offline"))
    await post("@reviewer Retry me", "read-kick-001")
    expect(mocks.store.chatDeliveries("lead", "local")).toHaveLength(1)
    mocks.state.mockClear()
    await readCrewChat("lead", {}, req)
    await vi.waitFor(() => expect(mocks.store.chatDeliveries("lead", "local")).toEqual([]))
    expect(mocks.state).toHaveBeenCalled()
  })

  it("resumes deliveries left pending by a restart without a read or post", async () => {
    vi.useFakeTimers()
    mocks.send.mockRejectedValue(new Error("offline"))
    await post("@reviewer Before the restart", "resume-chat-001")
    closeCrewChatMonitor()
    mocks.send.mockReset().mockResolvedValue({ delivery: "queued" })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.send).not.toHaveBeenCalled()
    resumeLocalCrewChat()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.send.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining(["reviewer", "lead"]))
    expect(mocks.store.chatDeliveries("lead", "local")).toEqual([])
  })

  it("lets any crew poll re-arm deliveries a restart left pending, where startup cannot (team edition)", async () => {
    vi.useFakeTimers()
    mocks.send.mockRejectedValue(new Error("offline"))
    await post("@reviewer After the restart", "rearm-chat-001")
    closeCrewChatMonitor()
    mocks.auth = {}
    mocks.send.mockReset().mockResolvedValue({ delivery: "queued" })
    resumeLocalCrewChat()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.send).not.toHaveBeenCalled()
    watchCrewChat("lead", req)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.send.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining(["reviewer"]))
    expect(mocks.store.chatDeliveries("lead", "local")).toEqual([])
  })

  it("arms nothing for a crew with nothing on its way", async () => {
    vi.useFakeTimers()
    watchCrewChat("lead", req)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mocks.host).not.toHaveBeenCalled()
  })
})
