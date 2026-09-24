// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const mockReadFile = vi.fn()
const mockWriteText = vi.fn()
const mockWriteFileSync = vi.fn()

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  mkdir: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  mkdirSync: vi.fn(),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}))
vi.mock("../../atomicJsonFile", () => ({
  writeOwnerOnlyText: (...args: unknown[]) => mockWriteText(...args),
}))

import { __resetEditionForTest } from "../../edition"
import { installFakeEdition } from "../edition/fakeEdition"
import {
  listNotifications,
  LOCAL_READER,
  markNotificationsRead,
  NOTIFICATION_HISTORY_FILE,
  notificationView,
  recordNotification,
  resetNotificationHistoryForTests,
  type NotificationHistoryEntry,
} from "../../lib/notificationHistory"

const CONTENT = { title: "Claude Code — proj", body: "Done", nav: { sessionId: "s1", dirName: "-d" } }

beforeEach(() => {
  vi.useFakeTimers()
  mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
  mockWriteText.mockResolvedValue(undefined)
  resetNotificationHistoryForTests()
})
afterEach(() => {
  resetNotificationHistoryForTests()
  vi.useRealTimers()
  mockReadFile.mockReset()
  mockWriteText.mockReset()
  mockWriteFileSync.mockReset()
  __resetEditionForTest()
})

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000)
}

/** The entries each write so far put on disk. */
function persisted(): NotificationHistoryEntry[][] {
  return mockWriteText.mock.calls.map(([, text]) => JSON.parse(text as string) as NotificationHistoryEntry[])
}

function recordMany(count: number, recipientId?: string): void {
  for (let i = 0; i < count; i++) recordNotification(CONTENT, "system", recipientId)
}

/** An edition keeping `hostEntries` for the host and gathering changes for `persistDelayMs` before a write. */
function retain(hostEntries: number, persistDelayMs = 500): void {
  installFakeEdition({ notificationRetention: { hostEntries, persistDelayMs } })
}

async function countsByRecipient(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const { recipientId = "host" } of await listNotifications()) counts[recipientId] = (counts[recipientId] ?? 0) + 1
  return counts
}

async function readAtFor(reader: string): Promise<Array<string | null>> {
  return (await listNotifications()).map((entry) => notificationView(entry, reader).readAt)
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
      readBy: {},
    })
  })

  it("returns the entry synchronously with a usable id", () => {
    const entry = recordNotification(CONTENT, "system")
    expect(entry.id).toBeTruthy()
    expect(entry.readBy).toEqual({})
    expect(entry).not.toHaveProperty("recipientId")
  })

  it("records a notification meant for one user alone", () => {
    expect(recordNotification(CONTENT, "system", "u_bob").recipientId).toBe("u_bob")
  })

  it("persists after the write delay", async () => {
    recordNotification(CONTENT, "turnComplete")
    expect(mockWriteText).not.toHaveBeenCalled()
    await flush()
    expect(mockWriteText).toHaveBeenCalledOnce()
    expect(persisted()[0]).toHaveLength(1)
  })

  it("writes the history as compact JSON", async () => {
    recordNotification(CONTENT, "turnComplete")
    await flush()
    expect(mockWriteText).toHaveBeenCalledWith(NOTIFICATION_HISTORY_FILE, JSON.stringify(await listNotifications()))
  })

  it("holds a write back as long as the edition says, gathering what comes in meanwhile", async () => {
    retain(200, 10_000)
    recordNotification(CONTENT, "turnComplete")
    await vi.advanceTimersByTimeAsync(9_000)
    expect(mockWriteText).not.toHaveBeenCalled()

    const entry = recordNotification(CONTENT, "permission")
    await markNotificationsRead("u_alice", [entry.id])
    await vi.advanceTimersByTimeAsync(1_000)

    expect(persisted()).toEqual([[expect.objectContaining({ id: entry.id, readBy: { u_alice: expect.any(String) } }), expect.anything()]])
  })

  it("writes what is still held back, compactly, when the process exits", async () => {
    retain(200, 10_000)
    recordNotification(CONTENT, "turnComplete")
    await vi.advanceTimersByTimeAsync(0)

    for (const listener of process.listeners("exit")) {
      if (listener.name === "flushSync") listener.call(process, 0)
    }

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      NOTIFICATION_HISTORY_FILE,
      JSON.stringify(await listNotifications()),
      { mode: 0o600 },
    )
  })

  it("marks entries read for one reader and persists the change", async () => {
    const entry = recordNotification(CONTENT, "turnComplete")
    await flush()
    mockWriteText.mockClear()

    await markNotificationsRead("u_alice", [entry.id, "unknown-id"])

    expect(await readAtFor("u_alice")).toEqual([expect.any(String)])
    await flush()
    expect(mockWriteText).toHaveBeenCalledOnce()
  })

  it("keeps each reader's read state apart", async () => {
    const entry = recordNotification(CONTENT, "turnComplete")
    await flush()

    await markNotificationsRead("u_alice", [entry.id])

    expect(await readAtFor("u_alice")).toEqual([expect.any(String)])
    expect(await readAtFor("u_bob")).toEqual([null])
    expect(await readAtFor(LOCAL_READER)).toEqual([null])
  })

  it("does not re-stamp an entry its reader already read", async () => {
    const entry = recordNotification(CONTENT, "turnComplete")
    await flush()
    await markNotificationsRead("u_alice", [entry.id])
    const [readAt] = await readAtFor("u_alice")
    await vi.advanceTimersByTimeAsync(5_000)
    await markNotificationsRead("u_alice", [entry.id])
    expect(await readAtFor("u_alice")).toEqual([readAt])
  })

  it("shows a reader their own read time and none of the rest", () => {
    const entry = recordNotification(CONTENT, "permission", "u_alice")
    entry.readBy = { u_alice: "2026-09-01T00:00:00.000Z", u_bob: "2026-09-02T00:00:00.000Z" }
    expect(notificationView(entry, "u_alice")).toEqual({
      id: entry.id,
      at: entry.at,
      title: CONTENT.title,
      body: CONTENT.body,
      kind: "permission",
      sessionId: "s1",
      dirName: "-d",
      readAt: "2026-09-01T00:00:00.000Z",
    })
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
      readBy: { u_alice: "2026-08-18T01:00:00.000Z" },
    }
    mockReadFile.mockResolvedValue(JSON.stringify([existing]))
    resetNotificationHistoryForTests(null)

    const fresh = recordNotification(CONTENT, "turnComplete")
    await flush()
    const list = await listNotifications()
    expect(list.map((e) => e.id)).toEqual([fresh.id, "old-1"])
    expect(list[1].readBy).toEqual(existing.readBy)
  })

  it("upgrades a history file that kept one read time, as the local reader's, and saves it once", async () => {
    const legacy = { at: "2026-08-18T00:00:00.000Z", title: "t", body: "b", kind: "system", sessionId: null, dirName: null }
    mockReadFile.mockResolvedValue(JSON.stringify([
      { ...legacy, id: "read", readAt: "2026-08-18T01:00:00.000Z" },
      { ...legacy, id: "unread", readAt: null },
    ]))
    resetNotificationHistoryForTests(null)

    const list = await listNotifications()
    expect(list.map(({ id, readBy }) => ({ id, readBy }))).toEqual([
      { id: "read", readBy: { [LOCAL_READER]: "2026-08-18T01:00:00.000Z" } },
      { id: "unread", readBy: {} },
    ])
    expect(list[0]).not.toHaveProperty("readAt")
    await flush()
    expect(mockWriteText).toHaveBeenCalledOnce()
    expect(persisted()[0].map((entry) => entry.readBy)).toEqual([{ [LOCAL_READER]: "2026-08-18T01:00:00.000Z" }, {}])
  })

  it("reads the kind a history file still calls \"share\" as \"access\", its recipientUserId as recipientId, and saves it once", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([
      { id: "granted", at: "2026-08-18T00:00:00.000Z", title: "t", body: "b", kind: "share", sessionId: "s1", dirName: "-d", readBy: {}, recipientUserId: "u_bob" },
      { id: "legacy", at: "2026-08-18T00:00:00.000Z", title: "t", body: "b", kind: "share", sessionId: "s1", dirName: "-d", readAt: null },
    ]))
    resetNotificationHistoryForTests(null)

    const list = await listNotifications()
    expect(list.map(({ id, kind, readBy }) => ({ id, kind, readBy }))).toEqual([
      { id: "granted", kind: "access", readBy: {} },
      { id: "legacy", kind: "access", readBy: {} },
    ])
    expect(list[0].recipientId).toBe("u_bob")
    expect(list[0]).not.toHaveProperty("recipientUserId")
    await flush()
    expect(mockWriteText).toHaveBeenCalledOnce()
    expect(persisted()[0].map((entry) => entry.kind)).toEqual(["access", "access"])
    expect(persisted()[0][0]).toMatchObject({ recipientId: "u_bob" })
    expect(persisted()[0][0]).not.toHaveProperty("recipientUserId")
  })

  it("does not rewrite a history file that needs no upgrade", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([
      { id: "n", at: "2026-08-18T00:00:00.000Z", title: "t", body: "b", kind: "system", sessionId: null, dirName: null, readBy: {} },
    ]))
    resetNotificationHistoryForTests(null)
    await listNotifications()
    await flush()
    expect(mockWriteText).not.toHaveBeenCalled()
  })

  it("tolerates a corrupt history file", async () => {
    mockReadFile.mockResolvedValue("{ not json")
    resetNotificationHistoryForTests(null)
    expect(await listNotifications()).toEqual([])
  })

  it("caps the log at 200 entries", async () => {
    recordMany(205)
    await flush()
    expect(await listNotifications()).toHaveLength(200)
  })

  it("keeps as many entries for the host as the edition says", async () => {
    retain(300)
    recordMany(305)
    await flush()
    expect(await listNotifications()).toHaveLength(300)
  })

  it("keeps a notice meant for one user apart from the host's entries", async () => {
    const granted = recordNotification(CONTENT, "access", "u_bob")
    recordMany(205)
    await flush()
    const list = await listNotifications()
    expect(list).toHaveLength(201)
    expect(list.at(-1)?.id).toBe(granted.id)
  })

  it("caps each user's own notices at 200 without evicting anyone else's", async () => {
    recordMany(3, "u_ann")
    recordMany(205, "u_bob")
    recordMany(4)
    await flush()
    expect(await countsByRecipient()).toEqual({ u_ann: 3, u_bob: 200, host: 4 })
  })

  it("holds a history file loaded from disk to the same caps", async () => {
    const stored = (id: string, recipientId?: string): NotificationHistoryEntry => ({
      id, at: "2026-08-18T00:00:00.000Z", title: "t", body: "b", kind: "system", sessionId: null, dirName: null, readBy: {},
      ...(recipientId === undefined ? {} : { recipientId }),
    })
    mockReadFile.mockResolvedValue(JSON.stringify([
      ...Array.from({ length: 201 }, (_, i) => stored(`bob-${i}`, "u_bob")),
      ...Array.from({ length: 202 }, (_, i) => stored(`host-${i}`)),
    ]))
    resetNotificationHistoryForTests(null)
    expect(await countsByRecipient()).toEqual({ u_bob: 200, host: 200 })
  })

  it("hands out a copy a later notification cannot shift", async () => {
    recordNotification(CONTENT, "system")
    await flush()
    const list = await listNotifications()
    recordNotification(CONTENT, "system")
    await flush()
    expect(list).toHaveLength(1)
  })
})
