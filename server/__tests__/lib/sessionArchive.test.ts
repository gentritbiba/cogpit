// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockDirs } = vi.hoisted(() => ({ mockDirs: { SESSION_CONFIG_DIR: "" } }))

vi.mock("../../helpers", async () => {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  return { dirs: mockDirs, join: path.join, mkdir: fs.mkdir, readFile: fs.readFile }
})

import {
  __resetSessionArchiveForTest,
  archiveReason,
  AUTO_ARCHIVE_AFTER_MS,
  forgetSessions,
  isStillArchived,
  REACTIVATION_GRACE_MS,
  readArchive,
  setSessionsArchived,
  subscribeArchiveChanges,
} from "../../lib/sessionArchive"

describe("sessionArchive", () => {
  let dir: string
  const filePath = () => join(mockDirs.SESSION_CONFIG_DIR, "archived-sessions.json")

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cogpit-archive-"))
    mockDirs.SESSION_CONFIG_DIR = join(dir, "session-config")
    __resetSessionArchiveForTest()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("starts empty when nothing has been archived", async () => {
    const snapshot = await readArchive()
    expect(snapshot.archived.size).toBe(0)
    expect(snapshot.kept.size).toBe(0)
  })

  it("archives, persists, and restores sessions, keeping restored ones", async () => {
    expect(await setSessionsArchived(["a", "b"], true, { now: 1_000 })).toEqual(["a", "b"])
    expect(await setSessionsArchived(["a"], true, { now: 2_000 })).toEqual([])

    expect(JSON.parse(await readFile(filePath(), "utf-8"))).toEqual({
      version: 3, sessions: { a: 1_000, b: 1_000 }, kept: {},
    })

    expect(await setSessionsArchived(["a", "missing"], false, { now: 2_500 })).toEqual(["a", "missing"])
    expect(await setSessionsArchived(["a"], false, { now: 2_600 })).toEqual([])
    const snapshot = await readArchive()
    expect([...snapshot.archived.keys()]).toEqual(["b"])
    expect([...snapshot.kept]).toEqual([["a", 2_500], ["missing", 2_500]])

    // Archiving a kept session drops the exemption again.
    expect(await setSessionsArchived(["a"], true, { now: 3_000 })).toEqual(["a"])
    expect((await readArchive()).kept.has("a")).toBe(false)
  })

  it("records the user's own choice at its time even where the session already stands that way", async () => {
    await setSessionsArchived(["a"], true, { now: 1_000 })
    await setSessionsArchived(["k"], false, { now: 1_000 })
    const changed = vi.fn()
    const unsubscribe = subscribeArchiveChanges(changed)

    expect(await setSessionsArchived(["a"], true, { now: 2_000, byUser: true })).toEqual([])
    expect(await setSessionsArchived(["k"], false, { now: 2_000, byUser: true })).toEqual([])
    unsubscribe()

    expect(changed).toHaveBeenCalledTimes(2)
    const snapshot = await readArchive()
    expect(snapshot.archived.get("a")).toBe(2_000)
    expect(snapshot.kept.get("k")).toBe(2_000)
  })

  it("reads the version 2 file, whose kept sessions carry no time", async () => {
    await mkdir(mockDirs.SESSION_CONFIG_DIR, { recursive: true })
    await writeFile(filePath(), JSON.stringify({ version: 2, sessions: { a: 5 }, kept: ["k"] }))

    const snapshot = await readArchive()
    expect(snapshot.archived.get("a")).toBe(5)
    expect(snapshot.kept.get("k")).toBe(0)
  })

  it("returns a snapshot that later writes do not mutate", async () => {
    await setSessionsArchived(["a"], true, { now: 5 })
    const snapshot = await readArchive()
    await setSessionsArchived(["a"], false)
    expect(snapshot.archived.has("a")).toBe(true)
  })

  it("forgets deleted sessions entirely", async () => {
    await setSessionsArchived(["a"], true, { now: 5 })
    await setSessionsArchived(["b"], false)
    await forgetSessions(["a", "b"])
    const snapshot = await readArchive()
    expect(snapshot.archived.size).toBe(0)
    expect(snapshot.kept.size).toBe(0)
  })

  it("reloads the file after a reset, ignoring corrupt content", async () => {
    await setSessionsArchived(["a"], true, { now: 5 })
    await setSessionsArchived(["k"], false)
    __resetSessionArchiveForTest()
    const snapshot = await readArchive()
    expect(snapshot.archived.get("a")).toBe(5)
    expect(snapshot.kept.has("k")).toBe(true)

    await writeFile(filePath(), "{not json")
    __resetSessionArchiveForTest()
    expect((await readArchive()).archived.size).toBe(0)
  })

  it("surfaces a failed write to the caller", async () => {
    await writeFile(join(dir, "blocker"), "")
    mockDirs.SESSION_CONFIG_DIR = join(dir, "blocker")
    __resetSessionArchiveForTest()
    await expect(setSessionsArchived(["a"], true)).rejects.toThrow()
  })

  it("treats activity after the grace period as a resumed session", () => {
    const archivedAt = 100_000
    expect(isStillArchived(undefined, archivedAt)).toBe(false)
    expect(isStillArchived(archivedAt, archivedAt - 1)).toBe(true)
    expect(isStillArchived(archivedAt, archivedAt + REACTIVATION_GRACE_MS)).toBe(true)
    expect(isStillArchived(archivedAt, archivedAt + REACTIVATION_GRACE_MS + 1)).toBe(false)
  })

  it("explains why a session is archived", () => {
    const now = 10 * AUTO_ARCHIVE_AFTER_MS
    const snapshot = { archived: new Map([["manual", now - 1_000]]), kept: new Map([["kept", 0]]) }
    expect(archiveReason(snapshot, "manual", now - 2_000, now)).toBe("manual")
    expect(archiveReason(snapshot, "manual", now + REACTIVATION_GRACE_MS * 2, now)).toBe(null)
    expect(archiveReason(snapshot, "fresh", now - 1_000, now)).toBe(null)
    expect(archiveReason(snapshot, "idle", now - AUTO_ARCHIVE_AFTER_MS - 1, now)).toBe("inactive")
    expect(archiveReason(snapshot, "kept", now - AUTO_ARCHIVE_AFTER_MS - 1, now)).toBe(null)
  })

  describe("with the agent CLI's own archive mark", () => {
    const now = 10 * AUTO_ARCHIVE_AFTER_MS
    const empty = { archived: new Map<string, number>(), kept: new Map<string, number>() }
    const archivedAt = (atMs: number) => ({ archived: true, atMs })
    const restoredAt = (atMs: number) => ({ archived: false, atMs })

    it("archives a session the CLI marked, until the transcript is written well after the mark", () => {
      expect(archiveReason(empty, "s", now - 5_000, now, archivedAt(now - 1_000))).toBe("manual")
      expect(archiveReason(empty, "s", now - 1_000 + REACTIVATION_GRACE_MS + 1, now, archivedAt(now - 1_000))).toBe(null)
    })

    it("lets the newer of Cogpit's choice and the CLI's mark decide", () => {
      const keptEarlier = { ...empty, kept: new Map([["s", now - 3_000]]) }
      const keptLater = { ...empty, kept: new Map([["s", now - 500]]) }
      const archivedEarlier = { ...empty, archived: new Map([["s", now - 3_000]]) }
      const archivedLater = { ...empty, archived: new Map([["s", now - 500]]) }
      const mtime = now - 5_000

      expect(archiveReason(keptEarlier, "s", mtime, now, archivedAt(now - 1_000))).toBe("manual")
      expect(archiveReason(keptLater, "s", mtime, now, archivedAt(now - 1_000))).toBe(null)
      expect(archiveReason(archivedEarlier, "s", mtime, now, restoredAt(now - 1_000))).toBe(null)
      expect(archiveReason(archivedLater, "s", mtime, now, restoredAt(now - 1_000))).toBe("manual")
    })

    it("keeps a session the CLI unarchived out of the idle rule", () => {
      const idle = now - AUTO_ARCHIVE_AFTER_MS - 1
      expect(archiveReason(empty, "s", idle, now, restoredAt(idle + 1))).toBe(null)
      expect(archiveReason(empty, "s", idle, now)).toBe("inactive")
    })

    it("applies the idle rule again to a session resumed after the CLI archived it", () => {
      const idle = now - AUTO_ARCHIVE_AFTER_MS - 1
      expect(archiveReason(empty, "s", idle, now, archivedAt(idle - REACTIVATION_GRACE_MS * 2))).toBe("inactive")
    })
  })

  it("tells subscribers after every write that changed the archive", async () => {
    const changed = vi.fn()
    const unsubscribe = subscribeArchiveChanges(changed)
    await setSessionsArchived(["a"], true)
    await setSessionsArchived(["a"], true)
    expect(changed).toHaveBeenCalledTimes(1)
    await setSessionsArchived(["a"], false)
    await forgetSessions(["a"])
    await forgetSessions(["a"])
    expect(changed).toHaveBeenCalledTimes(3)
    unsubscribe()
    await setSessionsArchived(["b"], true)
    expect(changed).toHaveBeenCalledTimes(3)
  })
})
