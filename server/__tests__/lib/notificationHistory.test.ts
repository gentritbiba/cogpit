// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const mockReadFile = vi.fn()
const mockWriteJson = vi.fn()

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  mkdir: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../../atomicJsonFile", () => ({
  writeOwnerOnlyJson: (...args: unknown[]) => mockWriteJson(...args),
}))

import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  recordNotification,
  resetNotificationHistoryForTests,
  type NotificationHistoryEntry,
} from "../../lib/notificationHistory"

const CONTENT = { title: "Claude Code — proj", body: "Done", nav: { sessionId: "s1", dirName: "-d" } }

beforeEach(() => {
  vi.useFakeTimers()
  mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
  mockWriteJson.mockResolvedValue(undefined)
  resetNotificationHistoryForTests()
})
afterEach(() => {
  vi.useRealTimers()
  mockReadFile.mockReset()
  mockWriteJson.mockReset()
})

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000)
}

describe("notificationHistory", () => {
  it("records notifications newest-first and returns them", async () => {
    const first = recordNotification(CONTENT, "turnComplete")
    const second = recordNotification({ ...CONTENT, body: "Blocked" }, "permission")
    await flush()

    const list = await listNotifications()
    expect(list.map((e) => e.id)).toEqual([second.id, first.id])
    expect(list[0]).toMatchObject({
      kind: "permission",
      body: "Blocked",
      sessionId: "s1",
      dirName: "-d",
      readAt: null,
    })
  })

  it("returns the entry synchronously with a usable id", () => {
    const entry = recordNotification(CONTENT, "system")
    expect(entry.id).toBeTruthy()
    expect(entry.readAt).toBeNull()
  })

  it("persists after the debounce window", async () => {
    recordNotification(CONTENT, "turnComplete")
    expect(mockWriteJson).not.toHaveBeenCalled()
    await flush()
    expect(mockWriteJson).toHaveBeenCalledOnce()
    const [, persisted] = mockWriteJson.mock.calls[0] as [string, NotificationHistoryEntry[]]
    expect(persisted).toHaveLength(1)
  })

  it("marks entries read and persists the change", async () => {
    const entry = recordNotification(CONTENT, "turnComplete")
    await flush()
    mockWriteJson.mockClear()

    await markNotificationsRead([entry.id, "unknown-id"])
    const [read] = await listNotifications()
    expect(read.readAt).not.toBeNull()
    await flush()
    expect(mockWriteJson).toHaveBeenCalledOnce()
  })

  it("does not re-stamp an already-read entry", async () => {
    const entry = recordNotification(CONTENT, "turnComplete")
    await flush()
    await markNotificationsRead([entry.id])
    const [{ readAt }] = await listNotifications()
    await vi.advanceTimersByTimeAsync(5_000)
    await markNotificationsRead([entry.id])
    const [after] = await listNotifications()
    expect(after.readAt).toBe(readAt)
  })

  it("marks everything read at once", async () => {
    recordNotification(CONTENT, "turnComplete")
    recordNotification(CONTENT, "permission")
    await flush()
    await markAllNotificationsRead()
    const list = await listNotifications()
    expect(list.every((e) => e.readAt !== null)).toBe(true)
  })

  it("loads existing history from disk and prepends new entries", async () => {
    const existing: NotificationHistoryEntry = {
      id: "old-1",
      at: "2026-08-18T00:00:00.000Z",
      title: "t",
      body: "b",
      kind: "system",
      sessionId: null,
      dirName: null,
      readAt: null,
    }
    mockReadFile.mockResolvedValue(JSON.stringify([existing]))
    resetNotificationHistoryForTests(null)

    const fresh = recordNotification(CONTENT, "turnComplete")
    await flush()
    const list = await listNotifications()
    expect(list.map((e) => e.id)).toEqual([fresh.id, "old-1"])
  })

  it("tolerates a corrupt history file", async () => {
    mockReadFile.mockResolvedValue("{ not json")
    resetNotificationHistoryForTests(null)
    expect(await listNotifications()).toEqual([])
  })

  it("caps the log at 200 entries", async () => {
    for (let i = 0; i < 205; i++) recordNotification(CONTENT, "system")
    await flush()
    expect(await listNotifications(1000)).toHaveLength(200)
  })

  it("respects the list limit", async () => {
    recordNotification(CONTENT, "system")
    recordNotification(CONTENT, "system")
    await flush()
    expect(await listNotifications(1)).toHaveLength(1)
  })
})
