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
}))
vi.mock("../../orchestration/storage", () => ({ orchestrationStore: () => mocks.store, closeOrchestrationStore: vi.fn(), beforeOrchestrationClose: vi.fn() }))
vi.mock("../../lib/sessionOrigins", () => ({ sessionParents: async () => mocks.parents }))
vi.mock("../../lib/durableSend", () => ({ commandScope: () => "local", refreshExecutionRequest: (req: IncomingMessage) => req }))
vi.mock("../../edition", () => ({ accessLevelOf: mocks.access, editionModule: () => ({ auth: null }), getRequestPrincipal: () => null }))
vi.mock("../../sessionHosts", () => ({ hostForSession: mocks.host }))
vi.mock("../../routes/hello", () => ({ getDeviceName: () => "coordinator-box" }))

import { DeviceRequestError } from "../../hub/deviceRequest"
import { closeCrewChatMonitor, CREW_CHAT_BUSY_GIVE_UP_MS, CREW_CHAT_BUSY_RETRY_MS, CREW_CHAT_DELIVERY_ATTEMPTS, CREW_CHAT_NOTICE_BUSY_ANSWERS, crewChatRetryDelay, deliverCrewChat, postCrewChat, readCrewChat, setCrewChatListening } from "../../lib/crewChat"
const req = {} as IncomingMessage
const deviceBusy = () => new DeviceRequestError("mb-pro", 409, "Session is already active", "CONFLICT")
const post = (text: string, commandId = "chat-message-001", senderSessionId = "parser", mentions?: string[]) => postCrewChat("parser", { text, commandId, senderSessionId, mentions }, req)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.store = new OrchestrationStore(":memory:")
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
    vi.useFakeTimers()
    let busy = true
    mocks.state.mockResolvedValue({ outcome: "running", running: true, activeNotifications: false })
    mocks.host.mockResolvedValue({ has: async () => true, state: mocks.state, send: mocks.send, remote: true })
    mocks.send.mockImplementation(async () => { if (busy) throw deviceBusy(); return { delivery: "accepted" } })
    const first = await post("@reviewer Check this")
    expect(first.pending).toEqual([{ sessionId: "reviewer", error: "Session is already active" }])
    for (const [, , options] of mocks.send.mock.calls) {
      expect(options).not.toHaveProperty("commandId")
      expect(options).not.toHaveProperty("leadSessionId")
    }
    busy = false
    await vi.advanceTimersByTimeAsync(CREW_CHAT_BUSY_RETRY_MS)
    await deliverCrewChat("lead", req)
    expect(mocks.store.chatDeliveries("lead", "local")).toEqual([])
  })

  it("deduplicates posts and retries failed deliveries with the same command ID", async () => {
    vi.useFakeTimers()
    mocks.send.mockRejectedValue(new Error("offline"))
    const first = await post("Retryable finding")
    expect(first.pending).toHaveLength(2)
    const ids = mocks.send.mock.calls.map(([, , options]) => options.commandId)
    mocks.send.mockResolvedValue({ delivery: "queued" })
    await vi.advanceTimersByTimeAsync(crewChatRetryDelay(1))
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
    await vi.advanceTimersByTimeAsync(crewChatRetryDelay(1) + 1_000)
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

  describe("deliveries to a member that stays out of reach", () => {
    const offline = () => {
      mocks.host.mockResolvedValue({ has: async () => true, state: mocks.state, send: mocks.send, remote: true })
      mocks.state.mockRejectedValue(new Error('Device "MB Pro" returned HTTP 502 while minting a token'))
    }
    const deliveryStates = () => (mocks.store as unknown as { db: { prepare: (sql: string) => { all: () => unknown[] } } }).db
      .prepare("SELECT state, attempts, count(*) AS count FROM crew_chat_deliveries GROUP BY state, attempts").all()
    const postFor = (count: number) => {
      for (let index = 0; index < count; index++) {
        mocks.store.postChat("local", `offline-chat-${String(index).padStart(4, "0")}`, { rootId: "lead", author: { kind: "user", name: "You" }, text: `Note ${index}`, mentions: ["reviewer"] }, [{ sessionId: "reviewer", kind: "mention" }])
      }
    }

    it("asks the device once per backoff step, writes once per delivery per step, and settles every delivery as failed", async () => {
      vi.useFakeTimers()
      offline()
      postFor(600)
      const defer = vi.spyOn(mocks.store, "deferChatDeliveries")
      const settle = vi.spyOn(mocks.store, "settleChatDelivery")
      await readCrewChat("lead", {}, req)
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(mocks.state).toHaveBeenCalledTimes(CREW_CHAT_DELIVERY_ATTEMPTS)
      expect(defer).toHaveBeenCalledTimes(CREW_CHAT_DELIVERY_ATTEMPTS)
      expect(defer.mock.calls.reduce((rows, [failures]) => rows + failures.length, 0)).toBe(600 * CREW_CHAT_DELIVERY_ATTEMPTS)
      expect(settle).not.toHaveBeenCalled()
      expect(deliveryStates()).toEqual([{ state: "failed", attempts: CREW_CHAT_DELIVERY_ATTEMPTS, count: 600 }])
      expect(vi.getTimerCount()).toBe(0)
      mocks.state.mockClear()
      await readCrewChat("lead", {}, req)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(mocks.state).not.toHaveBeenCalled()
    })

    it("skips a notice to a member it cannot reach instead of retrying it, and still notifies the others", async () => {
      vi.useFakeTimers()
      for (const [unreachable, reason] of [[() => { throw new Error('Device "MB Pro" returned HTTP 502 while minting a token') }, 'Device "MB Pro" returned HTTP 502 while minting a token'], [() => ({ outcome: "unreachable", error: "Device offline" }), "Device offline"]] as const) {
        mocks.store.close()
        mocks.store = new OrchestrationStore(":memory:")
        mocks.state.mockReset().mockImplementation(async (id: string) => (id === "reviewer" ? unreachable() : { outcome: "running", running: true, activeNotifications: true }))
        mocks.send.mockClear()
        expect((await post("Finding")).pending).toEqual([])
        expect(mocks.send.mock.calls.map(([id]) => id)).toContain("lead")
        expect(mocks.send.mock.calls.map(([id]) => id)).not.toContain("reviewer")
        expect(mocks.store.chatDeliveries("lead", "local")).toEqual([])
        const db = (mocks.store as unknown as { db: { prepare: (sql: string) => { get: (id: string) => Record<string, unknown> } } }).db
        expect(db.prepare("SELECT state,error,attempts FROM crew_chat_deliveries WHERE session_id=?").get("reviewer")).toEqual({ state: "skipped", error: reason, attempts: 0 })
        mocks.state.mockClear()
        await vi.advanceTimersByTimeAsync(10 * 60_000)
        expect(mocks.state).not.toHaveBeenCalled()
      }
    })

    it("asks a tagged member it cannot reach only at backoff steps and writes nothing on the ticks between", async () => {
      vi.useFakeTimers()
      mocks.state.mockImplementation(async (id: string) => (id === "reviewer" ? { outcome: "unreachable", error: "Device offline" } : { outcome: "running", running: true, activeNotifications: true }))
      await post("@reviewer Check this")
      expect(mocks.store.chatDeliveries("lead", "local")).toEqual([expect.objectContaining({ sessionId: "reviewer", error: "Device offline", attempts: 1 })])
      const defer = vi.spyOn(mocks.store, "deferChatDeliveries")
      const settle = vi.spyOn(mocks.store, "settleChatDelivery")
      const asked: number[] = []
      for (let second = 1; second <= 40; second++) {
        mocks.state.mockClear()
        await vi.advanceTimersByTimeAsync(1_000)
        if (mocks.state.mock.calls.some(([id]) => id === "reviewer")) asked.push(second)
      }
      expect(asked).toEqual([5, 15, 35])
      expect(defer.mock.calls.map(([failures]) => failures.length)).toEqual([1, 1, 1])
      expect(settle).not.toHaveBeenCalled()
    })

    const remoteAnswers = (answer: () => unknown) => {
      mocks.state.mockResolvedValue({ outcome: "running", running: true, activeNotifications: false })
      mocks.host.mockResolvedValue({ has: async () => true, state: mocks.state, send: mocks.send, remote: true })
      mocks.send.mockImplementation(async () => answer())
    }

    it("retries a mention to a busy remote member every few seconds, without spending attempts, until it takes it", async () => {
      vi.useFakeTimers()
      let busy = true
      remoteAnswers(() => { if (busy) throw deviceBusy(); return { delivery: "accepted" } })
      postFor(1)
      const defer = vi.spyOn(mocks.store, "deferChatDeliveries")
      await readCrewChat("lead", {}, req)
      await vi.advanceTimersByTimeAsync(0)
      for (let step = 1; step <= 3; step++) {
        await vi.advanceTimersByTimeAsync(CREW_CHAT_BUSY_RETRY_MS - 1_000)
        expect(mocks.send, `before retry ${step}`).toHaveBeenCalledTimes(step)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(mocks.send, `retry ${step}`).toHaveBeenCalledTimes(step + 1)
      }
      await vi.advanceTimersByTimeAsync(CREW_CHAT_BUSY_GIVE_UP_MS - 5 * CREW_CHAT_BUSY_RETRY_MS)
      expect(deliveryStates()).toEqual([{ state: "pending", attempts: 0, count: 1 }])
      expect(defer).toHaveBeenCalledTimes(mocks.send.mock.calls.length)
      busy = false
      await vi.advanceTimersByTimeAsync(CREW_CHAT_BUSY_RETRY_MS)
      expect(deliveryStates()).toEqual([{ state: "accepted", attempts: 0, count: 1 }])
    })

    it("gives up a mention after an hour of busy answers, keeping the reason", async () => {
      vi.useFakeTimers()
      remoteAnswers(() => { throw deviceBusy() })
      postFor(1)
      await readCrewChat("lead", {}, req)
      await vi.advanceTimersByTimeAsync(CREW_CHAT_BUSY_GIVE_UP_MS - 2 * CREW_CHAT_BUSY_RETRY_MS)
      expect(deliveryStates()).toEqual([{ state: "pending", attempts: 0, count: 1 }])
      await vi.advanceTimersByTimeAsync(4 * CREW_CHAT_BUSY_RETRY_MS)
      const db = (mocks.store as unknown as { db: { prepare: (sql: string) => { get: () => Record<string, unknown> } } }).db
      expect(db.prepare("SELECT state,error,attempts FROM crew_chat_deliveries").get()).toEqual({ state: "failed", error: "Session is already active", attempts: 0 })
      const asked = mocks.send.mock.calls.length
      expect(asked).toBeLessThanOrEqual(CREW_CHAT_BUSY_GIVE_UP_MS / CREW_CHAT_BUSY_RETRY_MS + 2)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(mocks.send).toHaveBeenCalledTimes(asked)
    })

    it("treats a 409 that is not the busy answer as a failure that gives up", async () => {
      for (const [code, message] of [["SESSION_UNCONFIRMED", "The native worktree directory is not available yet."], ["ACP_ERROR", "This ACP provider cannot reload sessions."]]) {
        vi.useFakeTimers()
        mocks.store.close()
        mocks.store = new OrchestrationStore(":memory:")
        remoteAnswers(() => { throw new DeviceRequestError("mb-pro", 409, message, code) })
        mocks.send.mockClear()
        postFor(1)
        await readCrewChat("lead", {}, req)
        await vi.advanceTimersByTimeAsync(60 * 60_000)
        expect(deliveryStates(), code).toEqual([{ state: "failed", attempts: CREW_CHAT_DELIVERY_ATTEMPTS, count: 1 }])
        expect(mocks.send, code).toHaveBeenCalledTimes(CREW_CHAT_DELIVERY_ATTEMPTS)
        closeCrewChatMonitor()
        vi.useRealTimers()
      }
    })

    it("counts only real failures toward giving up, however often the member was busy", async () => {
      vi.useFakeTimers()
      let answer: "busy" | "offline" = "busy"
      remoteAnswers(() => { throw answer === "busy" ? deviceBusy() : new DeviceRequestError("mb-pro", 502, "Bad gateway") })
      postFor(1)
      await readCrewChat("lead", {}, req)
      await vi.advanceTimersByTimeAsync(CREW_CHAT_BUSY_RETRY_MS * (CREW_CHAT_DELIVERY_ATTEMPTS + 2))
      answer = "offline"
      await vi.advanceTimersByTimeAsync(CREW_CHAT_BUSY_RETRY_MS)
      expect(deliveryStates()).toEqual([{ state: "pending", attempts: 1, count: 1 }])
      expect(mocks.store.chatDeliveries("lead", "local")[0]).toMatchObject({ busySince: 0, error: "Bad gateway" })
    })

    it("asks a busy member twice more about a notice, shortly, then skips it", async () => {
      vi.useFakeTimers()
      let busy = true
      remoteAnswers(() => { if (busy) throw deviceBusy(); return { delivery: "accepted" } })
      mocks.state.mockResolvedValue({ outcome: "running", running: true, activeNotifications: true })
      await post("Finding")
      const recipients = new Set(mocks.send.mock.calls.map(([id]) => id)).size
      expect(recipients).toBeGreaterThan(0)
      for (let answer = 2; answer <= CREW_CHAT_NOTICE_BUSY_ANSWERS; answer++) {
        expect(deliveryStates()).toEqual([{ state: "pending", attempts: 0, count: recipients }])
        await vi.advanceTimersByTimeAsync(CREW_CHAT_BUSY_RETRY_MS)
        expect(mocks.send).toHaveBeenCalledTimes(answer * recipients)
      }
      expect(deliveryStates()).toEqual([{ state: "skipped", attempts: 0, count: recipients }])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mocks.send).toHaveBeenCalledTimes(CREW_CHAT_NOTICE_BUSY_ANSWERS * recipients)

      mocks.send.mockClear()
      await post("Second finding", "chat-message-002")
      busy = false
      await vi.advanceTimersByTimeAsync(CREW_CHAT_BUSY_RETRY_MS)
      expect(deliveryStates()).toContainEqual({ state: "accepted", attempts: 0, count: recipients })
    })

    it("keeps the deferrals it collected when a pass throws partway", async () => {
      offline()
      postFor(2)
      const chatMessage = mocks.store.chatMessage.bind(mocks.store)
      vi.spyOn(mocks.store, "chatMessage").mockImplementationOnce(chatMessage).mockImplementationOnce(() => { throw new Error("database is locked") })
      await expect(deliverCrewChat("lead", req)).rejects.toThrow("database is locked")
      expect(deliveryStates()).toEqual([{ state: "pending", attempts: 0, count: 1 }, { state: "pending", attempts: 1, count: 1 }])
      expect(mocks.store.dueChatDeliveries("lead", "local", Date.now())).toHaveLength(1)
    })

    it("settles a message the member took without sending it again when the first settle throws", async () => {
      vi.useFakeTimers()
      postFor(1)
      const settle = mocks.store.settleChatDelivery.bind(mocks.store)
      vi.spyOn(mocks.store, "settleChatDelivery").mockImplementationOnce(() => { throw new Error("database is locked") }).mockImplementation(settle)
      await readCrewChat("lead", {}, req)
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.send).toHaveBeenCalledOnce()
      expect(deliveryStates()).toEqual([{ state: "pending", attempts: 0, count: 1 }])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(mocks.send).toHaveBeenCalledOnce()
      expect(deliveryStates()).toEqual([{ state: "accepted", attempts: 0, count: 1 }])
    })

    it("keeps the last reason on a delivery that gave up", async () => {
      vi.useFakeTimers()
      offline()
      postFor(1)
      const [delivery] = mocks.store.chatDeliveries("lead", "local")
      await readCrewChat("lead", {}, req)
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      mocks.store.settleChatDelivery(delivery!, "skipped")
      expect(mocks.store.chatDeliveries("lead", "local")).toEqual([])
      const db = (mocks.store as unknown as { db: { prepare: (sql: string) => { get: () => Record<string, unknown> } } }).db
      expect(db.prepare("SELECT state,error,attempts FROM crew_chat_deliveries").get()).toEqual({ state: "failed", error: 'Device "MB Pro" returned HTTP 502 while minting a token', attempts: CREW_CHAT_DELIVERY_ATTEMPTS })
    })

    it("waits out each backoff step, even when crew reads ask for delivery sooner", async () => {
      vi.useFakeTimers()
      offline()
      postFor(1)
      await readCrewChat("lead", {}, req)
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.state).toHaveBeenCalledTimes(1)
      for (let attempt = 1; attempt < CREW_CHAT_DELIVERY_ATTEMPTS; attempt++) {
        const delay = crewChatRetryDelay(attempt)
        await vi.advanceTimersByTimeAsync(delay - 1_500)
        await readCrewChat("lead", {}, req)
        await deliverCrewChat("lead", req)
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.state, `before retry ${attempt}`).toHaveBeenCalledTimes(attempt)
        await vi.advanceTimersByTimeAsync(1_500)
        expect(mocks.state, `retry ${attempt}`).toHaveBeenCalledTimes(attempt + 1)
      }
      expect(crewChatRetryDelay(CREW_CHAT_DELIVERY_ATTEMPTS)).toBe(5 * 60_000)
    })

    it("never brings back a delivery that was settled elsewhere while a pass was out", async () => {
      for (const outcome of ["fails", "succeeds"] as const) {
        mocks.store.close()
        mocks.store = new OrchestrationStore(":memory:")
        let answer!: () => void
        mocks.state.mockImplementation(() => new Promise((resolve, reject) => { answer = () => (outcome === "fails" ? reject(new Error("offline")) : resolve({ outcome: "running", running: true, activeNotifications: true })) }))
        postFor(1)
        const [delivery] = mocks.store.chatDeliveries("lead", "local")
        const pass = deliverCrewChat("lead", req)
        await vi.waitFor(() => expect(mocks.state).toHaveBeenCalled())
        expect(mocks.store.settleChatDelivery(delivery!, "skipped", "Settled by hand")).toBe(true)
        answer()
        await pass
        expect(mocks.store.chatDeliveries("lead", "local"), outcome).toEqual([])
        const db = (mocks.store as unknown as { db: { prepare: (sql: string) => { get: () => Record<string, unknown> } } }).db
        expect(db.prepare("SELECT state,error,attempts FROM crew_chat_deliveries").get(), outcome).toEqual({ state: "skipped", error: "Settled by hand", attempts: 0 })
        mocks.state.mockReset()
      }
    })
  })
})
