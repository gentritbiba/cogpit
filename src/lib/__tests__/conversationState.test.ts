import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CommandReceipt } from "../../../shared/contracts/orchestration"

vi.mock("../auth", () => ({ authFetch: vi.fn(() => new Promise(() => {})), authUrl: (url: string) => url }))
import { admitReceipt, conversationStateFor } from "../conversationState"
import { authFetch } from "../auth"

const receipt: CommandReceipt = { id: "command", conversationId: "conversation", sessionId: "s1", bindingRevision: 1, state: "queued", intent: "queue", message: "hello", createdAt: 1, updatedAt: 1, position: 1 }

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  vi.mocked(authFetch).mockReset().mockImplementation(() => new Promise(() => {}))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function response(state = "queued", init: { etag?: string; revision?: number } = {}) {
  return new Response(JSON.stringify({ conversation: { id: "conversation", revision: init.revision ?? 1 }, commands: [{ ...receipt, state }] }), { headers: init.etag ? { ETag: init.etag } : {} })
}
const notModified = () => new Response(null, { status: 304 })
const sentTag = (call: number) => new Headers(vi.mocked(authFetch).mock.calls[call]?.[1]?.headers).get("If-None-Match")
const sentUrl = (call: number) => String(vi.mocked(authFetch).mock.calls[call]?.[0])

describe("admitReceipt", () => {
  it("keeps the same snapshot and does not notify subscribers for unchanged polls", async () => {
    vi.mocked(authFetch).mockImplementation(async () => response())
    const owner = conversationStateFor("unchanged")
    const changed = vi.fn()
    const stop = owner.subscribe(changed)
    try {
      await vi.advanceTimersByTimeAsync(0)
      const first = owner.snapshot()
      expect(changed).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(authFetch).toHaveBeenCalledTimes(3)
      expect(owner.snapshot()).toBe(first)
      expect(changed).toHaveBeenCalledOnce()
      vi.mocked(authFetch).mockImplementation(async () => response("completed"))
      await vi.advanceTimersByTimeAsync(3_000)
      expect(owner.snapshot().commands[0]?.state).toBe("completed")
      expect(changed).toHaveBeenCalledTimes(2)
    } finally { stop() }
  })

  it("revalidates with the ETag, keeps the snapshot on 304, and only refreshes freshness", async () => {
    vi.mocked(authFetch).mockImplementationOnce(async () => response("queued", { etag: 'W/"one"' })).mockImplementation(async () => notModified())
    const owner = conversationStateFor("etag")
    const changed = vi.fn()
    const stop = owner.subscribe(changed)
    try {
      await vi.advanceTimersByTimeAsync(0)
      const first = owner.snapshot()
      expect(sentTag(0)).toBeNull()
      expect(sentUrl(0)).toBe("/api/session-commands?sessionId=etag")
      await vi.advanceTimersByTimeAsync(2_000)
      expect(sentTag(1)).toBe('W/"one"')
      expect(owner.snapshot()).toBe(first)
      expect(changed).toHaveBeenCalledOnce()

      vi.mocked(authFetch).mockImplementationOnce(async () => new Response("{}", { status: 500 }))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(owner.snapshot()).toMatchObject({ freshness: "stale", commands: first.commands })
      await vi.advanceTimersByTimeAsync(4_000)
      expect(sentTag(3)).toBe('W/"one"')
      expect(owner.snapshot()).toMatchObject({ freshness: "current", error: undefined })
      expect(owner.snapshot().commands).toBe(first.commands)
      expect(changed).toHaveBeenCalledTimes(3)
    } finally { stop() }
  })

  it("notifies on a changed poll and keeps the unchanged commands array", async () => {
    vi.mocked(authFetch).mockImplementationOnce(async () => response("queued", { etag: 'W/"one"' })).mockImplementationOnce(async () => response("queued", { etag: 'W/"two"', revision: 2 }))
    const owner = conversationStateFor("changed")
    const changed = vi.fn()
    const stop = owner.subscribe(changed)
    try {
      await vi.advanceTimersByTimeAsync(0)
      const first = owner.snapshot()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(changed).toHaveBeenCalledTimes(2)
      expect(owner.snapshot().conversation?.revision).toBe(2)
      expect(owner.snapshot().commands).toBe(first.commands)
      expect(sentTag(1)).toBe('W/"one"')
    } finally { stop() }
  })

  it("drops the ETag when a receipt is admitted locally, so the next poll reads the server's list", async () => {
    vi.mocked(authFetch).mockImplementation(async () => response("queued", { etag: 'W/"one"' }))
    const owner = conversationStateFor("s1")
    const stop = owner.subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(0)
      admitReceipt({ ...receipt, id: "local" })
      expect(owner.snapshot().commands.map((command) => command.id)).toEqual(["command", "local"])
      await vi.advanceTimersByTimeAsync(2_000)
      expect(sentTag(1)).toBeNull()
      expect(owner.snapshot().commands.map((command) => command.id)).toEqual(["command"])
    } finally { stop() }
  })

  it("ignores a 304 for a tag that a local admit has since replaced", async () => {
    let release = (_: Response) => {}
    vi.mocked(authFetch).mockImplementationOnce(async () => response("queued", { etag: 'W/"one"' })).mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const owner = conversationStateFor("s1")
    const stop = owner.subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(2_000)
      admitReceipt({ ...receipt, id: "local" })
      release(notModified())
      await vi.advanceTimersByTimeAsync(0)
      expect(owner.snapshot().freshness).toBe("current")
      expect(owner.snapshot().commands.map((command) => command.id)).toEqual(["command", "local"])
    } finally { stop() }
  })

  it("asks for watched commands by id until they are unwatched", async () => {
    vi.mocked(authFetch).mockImplementation(async () => response())
    const owner = conversationStateFor("watch")
    const stop = owner.subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(0)
      const unwatch = owner.watch("a b")
      await vi.advanceTimersByTimeAsync(2_000)
      expect(sentUrl(1)).toBe("/api/session-commands?sessionId=watch&commandId=a%20b")
      unwatch()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(sentUrl(2)).toBe("/api/session-commands?sessionId=watch")
    } finally { stop() }
  })

  it("stops queue requests while hidden and resumes on visibility", async () => {
    vi.mocked(authFetch).mockImplementation(async () => response())
    const visibility = vi.spyOn(document, "visibilityState", "get")
    const owner = conversationStateFor("hidden")
    const stop = owner.subscribe(() => {})
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(authFetch).toHaveBeenCalledOnce()
      visibility.mockReturnValue("hidden")
      await vi.advanceTimersByTimeAsync(20_000)
      expect(authFetch).toHaveBeenCalledOnce()
      visibility.mockReturnValue("visible")
      document.dispatchEvent(new Event("visibilitychange"))
      await vi.advanceTimersByTimeAsync(0)
      expect(authFetch).toHaveBeenCalledTimes(2)
    } finally { stop() }
  })

  it("shows an accepted command only in a queue someone is watching, once", () => {
    expect(admitReceipt(receipt)).toBe(false)

    const owner = conversationStateFor("s1")
    const stop = owner.subscribe(() => {})
    expect(admitReceipt(receipt)).toBe(true)
    expect(admitReceipt(receipt)).toBe(true)
    expect(owner.snapshot().commands).toEqual([receipt])

    stop()
    expect(admitReceipt(receipt)).toBe(false)
  })
})
